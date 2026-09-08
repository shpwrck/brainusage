import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readTextFile, replaceTextFile} from '../../extension/lib/runtime/fs.js';
const dir = GLib.dir_make_tmp('brainusage-test-XXXXXX');
const path = `${dir}/credentials.json`;
GLib.file_set_contents(path, 'old');
await replaceTextFile(path, 'old', 'new');
if (await readTextFile(path) !== 'new') throw new Error('write failed');
const file = Gio.File.new_for_path(path);
const mode = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o777;
if (mode !== 0o600) throw new Error(`unsafe mode ${mode}`);
let conflict = false;
try { await replaceTextFile(path, 'old', 'wrong'); } catch { conflict = true; }
if (!conflict || await readTextFile(path) !== 'new') throw new Error('conflict check failed');
file.delete(null);
Gio.File.new_for_path(dir).delete(null);
print('Gio atomic write, 0600 permissions and conflict protection passed');
