import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PANEL_ITEMS} from './lib/ui/render.js';

export default class BrainUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        page.add(this._buildPanelGroup(settings));
        page.add(this._buildPollingGroup(settings));
        page.add(this._buildNotificationsGroup(settings));

        // Keep settings alive for the lifetime of the window.
        window._settings = settings;
    }

    _buildPanelGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Panel metrics',
            description: 'Choose which remaining-usage values appear in the top bar',
        });

        let syncing = false;
        const rows = [];

        for (const item of PANEL_ITEMS) {
            const row = new Adw.SwitchRow({
                title: item.label,
                subtitle: item.providerName
                    ? `Shown as “${item.windowLabel}” next to the ${item.providerName} logo`
                    : 'Lowest percentage across all windows',
                active: settings.get_strv('panel-items').includes(item.key),
            });
            row.connect('notify::active', () => {
                if (syncing)
                    return;

                const current = new Set(settings.get_strv('panel-items'));
                if (row.active)
                    current.add(item.key);
                else
                    current.delete(item.key);

                const ordered = PANEL_ITEMS.map(i => i.key).filter(k => current.has(k));
                settings.set_strv('panel-items', ordered);
            });
            rows.push({row, key: item.key});
            group.add(row);
        }

        settings.connect('changed::panel-items', () => {
            syncing = true;
            const enabled = settings.get_strv('panel-items');
            for (const {row, key} of rows)
                row.active = enabled.includes(key);
            syncing = false;
        });

        const labelsRow = new Adw.SwitchRow({
            title: 'Show metric labels',
            subtitle: 'Prefix each value with its short label when more than one metric is shown',
        });
        settings.bind('panel-show-labels', labelsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(labelsRow);

        return group;
    }

    _buildPollingGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Polling'});

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage checks',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
            }),
        });
        settings.bind('poll-interval-seconds', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(intervalRow);

        return group;
    }

    _buildNotificationsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Notifications'});

        const enabledRow = new Adw.SwitchRow({
            title: 'Low-usage notifications',
            subtitle: 'Notify when a session or weekly limit drops below the threshold',
        });
        settings.bind('notifications-enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabledRow);

        const thresholdRow = new Adw.SpinRow({
            title: 'Notification threshold',
            subtitle: 'Remaining percentage that triggers a notification',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 99,
                step_increment: 1,
                page_increment: 10,
            }),
        });
        settings.bind('notify-threshold-pct', thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notifications-enabled', thresholdRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(thresholdRow);

        return group;
    }
}
