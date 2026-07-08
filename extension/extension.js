import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createScheduler} from './lib/core/scheduler.js';
import {createThresholdNotifier} from './lib/core/notifications.js';
import {createClaudeProvider} from './lib/providers/claude.js';
import {createCodexProvider} from './lib/providers/codex.js';
import {readTextFile} from './lib/runtime/fs.js';
import {createFetch} from './lib/runtime/fetch.js';
import {buildUsageViewModel, PANEL_ITEMS, PANEL_LABEL_MODES} from './lib/ui/render.js';

const FILL_CLASSES = {
    green: 'usage-fill-green',
    yellow: 'usage-fill-yellow',
    red: 'usage-fill-red',
};

const PANEL_VALUE_CLASSES = {
    green: 'usage-panel-value usage-value-green',
    yellow: 'usage-panel-value usage-value-yellow',
    red: 'usage-panel-value usage-value-red',
};

const StayOpenSwitchMenuItem = GObject.registerClass(
class StayOpenSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {
    activate(_event) {
        // Skipping super.activate() suppresses the 'activate' emission whose
        // menu-level handler closes the popup, so several switches can be
        // toggled in a row. toggle() still updates ATK checked state.
        if (this._switch?.mapped)
            this.toggle();
    }
});

function loadProviderIcons(extensionPath) {
    const iconFor = (name) => new Gio.FileIcon({
        file: Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'assets', `${name}-symbolic.svg`]),
        ),
    });

    return {codex: iconFor('codex'), claude: iconFor('claude')};
}

function createPanelGroupWidgets(group, providerIcon) {
    const box = new St.BoxLayout({
        style_class: 'usage-panel-group',
        y_align: Clutter.ActorAlign.CENTER,
    });

    if (providerIcon) {
        const icon = new St.Icon({
            gicon: providerIcon,
            style_class: `usage-panel-icon usage-panel-icon-${group.providerKey}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);
    }

    const valueLabels = new Map();
    for (const item of group.items) {
        const metricBox = new St.BoxLayout({
            style_class: 'usage-panel-metric',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (item.label) {
            const contextLabel = new St.Label({
                text: item.label,
                style_class: 'usage-panel-context',
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Dim via actor opacity so the label adapts to any shell theme.
            contextLabel.opacity = 170;
            metricBox.add_child(contextLabel);
        }
        const valueLabel = new St.Label({
            text: item.percentText,
            style_class: PANEL_VALUE_CLASSES[item.dotColor] ?? PANEL_VALUE_CLASSES.red,
            y_align: Clutter.ActorAlign.CENTER,
        });
        metricBox.add_child(valueLabel);
        box.add_child(metricBox);
        valueLabels.set(item.key, valueLabel);
    }

    return {box, valueLabels};
}

function createWindowWidgets() {
    const box = new St.BoxLayout({
        vertical: true,
        style_class: 'usage-window-row',
    });

    const label = new St.Label({style_class: 'usage-window-label'});

    const track = new St.BoxLayout({style_class: 'usage-progress-track'});
    track.set_x_expand(true);
    const fill = new St.Widget({style_class: 'usage-fill-green'});
    fill._remainingPct = 0;
    track.add_child(fill);

    track.connect('notify::allocation', () => {
        const node = track.get_theme_node();
        if (!node) return;
        const contentBox = node.get_content_box(track.get_allocation_box());
        const contentWidth = contentBox.x2 - contentBox.x1;
        if (contentWidth > 0)
            fill.set_width(Math.round(contentWidth * fill._remainingPct / 100));
    });

    const infoRow = new St.BoxLayout({style_class: 'usage-info-row'});
    infoRow.set_x_expand(true);
    const remainingLabel = new St.Label({text: '-- left'});
    const resetsLabel = new St.Label({text: '--'});
    const spacer = new St.Widget();
    spacer.set_x_expand(true);
    infoRow.add_child(remainingLabel);
    infoRow.add_child(spacer);
    infoRow.add_child(resetsLabel);

    box.add_child(label);
    box.add_child(track);
    box.add_child(infoRow);

    return {box, label, track, fill, remainingLabel, resetsLabel};
}

function createServiceSection() {
    const container = new St.BoxLayout({vertical: true, style_class: 'usage-service-card'});

    const header = new St.BoxLayout({style_class: 'usage-service-header'});
    const nameLabel = new St.Label({style_class: 'usage-service-name'});
    header.add_child(nameLabel);

    const window0 = createWindowWidgets();
    const window1 = createWindowWidgets();

    const warningLabel = new St.Label({style_class: 'usage-warning'});
    warningLabel.hide();

    container.add_child(header);
    container.add_child(window0.box);
    container.add_child(window1.box);
    container.add_child(warningLabel);

    return {container, nameLabel, windows: [window0, window1], warningLabel};
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(scheduler, settings, providerIcons, openPrefsFn) {
        super._init(0.0, 'Usage Indicator');

        this._scheduler = scheduler;
        this._settings = settings;
        this._providerIcons = providerIcons;
        this._openPrefsFn = openPrefsFn ?? null;
        this._lastSummary = null;
        this._timerSourceId = 0;
        this._itemSwitches = [];
        this._syncingSwitches = false;
        this._panelShapeKey = null;
        this._panelValueLabels = new Map();

        this._panelBox = new St.BoxLayout({
            style_class: 'usage-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);
        this._applyPanelGroups({panelGroups: []});

        this._buildPopup();
        this._startRelativeTimeTimer();

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._syncDisplaySwitches();
            this._refreshRelativeTimes();
        });
    }

    _buildPopup() {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'usage-popup-box',
        });

        this._codexSection = createServiceSection();
        this._codexSection.nameLabel.text = 'Codex';

        this._claudeSection = createServiceSection();
        this._claudeSection.nameLabel.text = 'Claude';

        const separator = new St.Widget({style_class: 'usage-separator'});
        separator.set_x_expand(true);

        const footerRow = new St.BoxLayout({style_class: 'usage-footer-row'});
        footerRow.set_x_expand(true);
        this._versionLabel = new St.Label({text: 'brainusage 1.0.1'});
        this._nextUpdateLabel = new St.Label({text: 'Next update in --'});
        const footerSpacer = new St.Widget();
        footerSpacer.set_x_expand(true);
        footerRow.add_child(this._versionLabel);
        footerRow.add_child(footerSpacer);
        footerRow.add_child(this._nextUpdateLabel);

        this._popupBox.add_child(this._codexSection.container);
        this._popupBox.add_child(this._claudeSection.container);
        this._popupBox.add_child(separator);
        this._popupBox.add_child(footerRow);

        menuItem.add_child(this._popupBox);
        this.menu.addMenuItem(menuItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshSignalId = refreshItem.connect('activate', () => {
            void this._scheduler?.refresh();
        });
        this._refreshItem = refreshItem;
        this.menu.addMenuItem(refreshItem);

        this._buildDisplaySubmenu();

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        this._settingsItemSignalId = settingsItem.connect('activate', () => {
            this._openPrefsFn?.();
        });
        this._settingsItem = settingsItem;
        this.menu.addMenuItem(settingsItem);
    }

    _buildDisplaySubmenu() {
        this._displaySubmenu = new PopupMenu.PopupSubMenuMenuItem('Panel display');
        this._itemSwitches = [];

        const enabledItems = this._settings.get_strv('panel-items');

        for (const item of PANEL_ITEMS) {
            const switchItem = new StayOpenSwitchMenuItem(
                item.label,
                enabledItems.includes(item.key),
            );
            switchItem._itemKey = item.key;
            switchItem.connect('toggled', (_item, state) => {
                if (!this._syncingSwitches)
                    this._setPanelItemEnabled(item.key, state);
            });
            this._itemSwitches.push(switchItem);
            this._displaySubmenu.menu.addMenuItem(switchItem);
        }

        this._labelsSwitch = new StayOpenSwitchMenuItem(
            'Show metric labels',
            this._settings.get_boolean('panel-show-labels'),
        );
        this._labelsSwitch.connect('toggled', (_item, state) => {
            if (!this._syncingSwitches)
                this._settings.set_boolean('panel-show-labels', state);
        });
        this._displaySubmenu.menu.addMenuItem(this._labelsSwitch);

        this.menu.addMenuItem(this._displaySubmenu);
    }

    _setPanelItemEnabled(key, enabled) {
        const current = new Set(this._settings.get_strv('panel-items'));
        if (enabled)
            current.add(key);
        else
            current.delete(key);

        // Keep the canonical PANEL_ITEMS order regardless of toggle order.
        const ordered = PANEL_ITEMS.map(item => item.key).filter(k => current.has(k));
        this._settings.set_strv('panel-items', ordered);
    }

    _syncDisplaySwitches() {
        this._syncingSwitches = true;

        const enabledItems = this._settings.get_strv('panel-items');
        for (const switchItem of this._itemSwitches)
            switchItem.setToggleState(enabledItems.includes(switchItem._itemKey));

        this._labelsSwitch?.setToggleState(this._settings.get_boolean('panel-show-labels'));

        this._syncingSwitches = false;
    }

    _startRelativeTimeTimer() {
        this._timerSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._refreshRelativeTimes();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _viewModelDeps() {
        return {
            now: Date.now(),
            pollIntervalMs: this._settings.get_int('poll-interval-seconds') * 1000,
            panelItems: this._settings.get_strv('panel-items'),
            panelShowLabels: this._settings.get_boolean('panel-show-labels'),
        };
    }

    _refreshRelativeTimes() {
        if (!this._lastSummary)
            return;

        this._applyViewModel(buildUsageViewModel(this._lastSummary, this._viewModelDeps()));
    }

    render(summary) {
        this._lastSummary = summary;
        this._applyViewModel(buildUsageViewModel(summary, this._viewModelDeps()));
    }

    _applyPanelGroups(vm) {
        // The widget tree is rebuilt only when the panel's shape changes
        // (selection or labels toggle); routine refreshes update text in place.
        const shapeKey = vm.panelGroups
            .map((group) => `${group.providerKey ?? 'min'}:${group.items.map((item) => `${item.key}=${item.label}`).join(',')}`)
            .join('|');

        if (shapeKey !== this._panelShapeKey) {
            this._panelShapeKey = shapeKey;
            this._panelValueLabels = new Map();
            this._panelBox.destroy_all_children();

            if (vm.panelGroups.length === 0) {
                this._panelBox.add_child(new St.Label({
                    text: '--',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                return;
            }

            for (const group of vm.panelGroups) {
                const {box, valueLabels} = createPanelGroupWidgets(
                    group,
                    group.providerKey ? this._providerIcons[group.providerKey] : null,
                );
                this._panelBox.add_child(box);
                for (const [key, label] of valueLabels)
                    this._panelValueLabels.set(key, label);
            }
            return;
        }

        for (const group of vm.panelGroups) {
            for (const item of group.items) {
                const label = this._panelValueLabels.get(item.key);
                if (!label)
                    continue;

                label.text = item.percentText;
                label.style_class = PANEL_VALUE_CLASSES[item.dotColor] ?? PANEL_VALUE_CLASSES.red;
            }
        }
    }

    _applyViewModel(vm) {
        this._applyPanelGroups(vm);

        const sections = [this._codexSection, this._claudeSection];

        for (let i = 0; i < vm.services.length; i++) {
            const svc = vm.services[i];
            const section = sections[i];

            section.nameLabel.text = svc.name;

            for (let j = 0; j < svc.windows.length; j++) {
                const w = svc.windows[j];
                const widgets = section.windows[j];

                widgets.label.text = w.label;
                widgets.fill.style_class = FILL_CLASSES[w.dotColor] ?? 'usage-fill-red';
                widgets.fill._remainingPct = w.remainingPct;
                widgets.remainingLabel.text = w.remainingText;
                widgets.resetsLabel.text = w.resetsInText;

                const node = widgets.track.get_theme_node();
                if (node) {
                    const contentBox = node.get_content_box(widgets.track.get_allocation_box());
                    const contentWidth = contentBox.x2 - contentBox.x1;
                    if (contentWidth > 0)
                        widgets.fill.set_width(Math.round(contentWidth * w.remainingPct / 100));
                }
            }

            if (svc.warning) {
                section.warningLabel.text = svc.warning;
                section.warningLabel.show();
            } else {
                section.warningLabel.hide();
            }
        }

        this._versionLabel.text = vm.version;
        this._nextUpdateLabel.text = vm.lastUpdate;
    }

    destroy() {
        if (this._timerSourceId) {
            GLib.source_remove(this._timerSourceId);
            this._timerSourceId = 0;
        }

        if (this._refreshSignalId && this._refreshItem) {
            this._refreshItem.disconnect(this._refreshSignalId);
            this._refreshSignalId = null;
        }

        if (this._settingsItemSignalId && this._settingsItem) {
            this._settingsItem.disconnect(this._settingsItemSignalId);
            this._settingsItemSignalId = null;
        }

        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._settings = null;
        super.destroy();
    }
});

export default class UsageLimitsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._migrateLegacySettings();

        this._fetchRuntime = createFetch();
        const fetchImpl = this._fetchRuntime.fetch;
        const fileReader = readTextFile;

        const claude = createClaudeProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        const codex = createCodexProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        this._thresholdNotifier = createThresholdNotifier({
            thresholdPct: () => this._settings?.get_int('notify-threshold-pct') ?? 20,
            notifyFn: (title, body) => {
                if (this._settings?.get_boolean('notifications-enabled'))
                    Main.notify(title, body);
            },
        });

        this._scheduler = createScheduler({
            providers: {claude, codex},
            pollIntervalMs: this._settings.get_int('poll-interval-seconds') * 1000,
            onUpdate: (summary) => {
                this._indicator?.render(summary);
                this._thresholdNotifier?.evaluate(summary);
            },
        });

        this._pollSettingId = this._settings.connect('changed::poll-interval-seconds', () => {
            this._scheduler?.setPollIntervalMs(this._settings.get_int('poll-interval-seconds') * 1000);
        });

        this._indicator = new UsageIndicator(
            this._scheduler,
            this._settings,
            loadProviderIcons(this.path),
            () => this.openPreferences(),
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduler.start();
    }

    _migrateLegacySettings() {
        // Older versions stored a single metric in panel-label-mode; carry it
        // over once, unless the user has already customized panel-items.
        const legacy = this._settings.get_user_value('panel-label-mode');
        if (!legacy || this._settings.get_user_value('panel-items'))
            return;

        const mode = this._settings.get_string('panel-label-mode');
        if (PANEL_LABEL_MODES.includes(mode) && mode !== 'min')
            this._settings.set_strv('panel-items', [mode]);
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._thresholdNotifier = null;

        this._fetchRuntime?.dispose();
        this._fetchRuntime = null;

        if (this._pollSettingId && this._settings) {
            this._settings.disconnect(this._pollSettingId);
            this._pollSettingId = null;
        }

        if (!this._indicator) {
            this._settings = null;
            return;
        }

        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
