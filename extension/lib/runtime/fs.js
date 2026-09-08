import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function resolvePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0)
        throw new Error('filePath must be a non-empty string');

    if (filePath.startsWith('~/'))
        return `${GLib.get_home_dir()}${filePath.slice(1)}`;

    return filePath;
}

function loadContents(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) {
                    reject(new Error(`Failed to read file: ${file.get_path()}`));
                    return;
                }

                resolve(contents);
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function readTextFile(filePath) {
    const resolvedPath = resolvePath(filePath);
    const file = Gio.File.new_for_path(resolvedPath);
    const contents = await loadContents(file);
    return new TextDecoder().decode(contents);
}

// Compare the snapshot and use Gio's etag check to avoid replacing a newer CLI
// login. PRIVATE + REPLACE_DESTINATION creates an owner-only file, no backup.
export async function replaceTextFile(filePath, expectedText, text) {
    const file = Gio.File.new_for_path(resolvePath(filePath));
    const etag = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents, version] = source.load_contents_finish(result);
                if (!ok || new TextDecoder().decode(contents) !== expectedText)
                    throw new Error('Credentials changed while refreshing; retry on next poll');
                resolve(version);
            } catch (error) {
                reject(error);
            }
        });
    });
    return new Promise((resolve, reject) => {
        file.replace_contents_async(new TextEncoder().encode(text), etag, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}
