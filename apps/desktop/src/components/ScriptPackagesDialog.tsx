import { Package, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { CodeEditor } from './CodeEditor';
import { Button, cx, Empty, Modal } from './ui';

const NAME = /^(@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/;
const TEMPLATE = `// Shared code for scripts. Use it with: const utils = pm.require('NAME');
// Packages are CommonJS modules: put what they offer on module.exports.
module.exports = {
  bearer(token) {
    return 'Bearer ' + token;
  },
};
`;

/**
 * Script packages: shared modules that scripts load with pm.require('name'), like Postman's package
 * library. They are files in the workspace (packages/<name>.js), so they travel with it in git.
 */
export function ScriptPackagesDialog({ onClose }: { onClose(): void }) {
  const [list, setList] = useState<Array<{ name: string; size: number }>>([]);
  const [sel, setSel] = useState<string>();
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState('');
  const reload = () => call<Array<{ name: string; size: number }>>('packages.list').then(setList);
  useEffect(() => void reload(), []);
  useEffect(() => {
    if (!sel) return;
    void call<string | null>('packages.get', { name: sel }).then((c) => {
      setCode(c ?? '');
      setSaved(c ?? '');
    });
  }, [sel]);
  const dirty = !!sel && code !== saved;
  const save = async () => {
    if (!sel) return;
    try {
      await call('packages.save', { name: sel, code });
      setSaved(code);
      await reload();
      useApp.getState().toast(`Saved package ${sel}`, 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const create = async () => {
    const name = (await promptText('New script package', { message: 'Name, e.g. utils or @team/auth', okLabel: 'Create' }))?.trim();
    if (!name) return;
    if (!NAME.test(name)) return useApp.getState().toast('Use letters, digits, . _ - (and an optional @scope/)', 'error');
    if (list.some((p) => p.name === name)) return setSel(name);
    await call('packages.save', { name, code: TEMPLATE.replace('NAME', name) });
    await reload();
    setSel(name);
  };
  const remove = async () => {
    if (!sel || !(await confirmAction({ title: `Delete ${sel}?`, message: 'Scripts that pm.require it will fail.', danger: true, confirmLabel: 'Delete' }))) return;
    await call('packages.delete', { name: sel });
    setSel(undefined);
    setCode('');
    await reload();
  };
  return (
    <Modal
      title="Script packages"
      onClose={onClose}
      width={1000}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            In a script: <code>const auth = pm.require('{sel ?? 'name'}');</code> Packages are files in the workspace (<code>packages/</code>).
          </span>
          {sel && (
            <Button variant="ghost" icon={<Trash2 size={13} />} onClick={() => void remove()}>
              Delete
            </Button>
          )}
          <Button variant="primary" icon={<Save size={13} />} disabled={!dirty} onClick={() => void save()}>
            {dirty ? 'Save*' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex h-[60vh] min-h-0 border border-line rounded-md overflow-hidden">
        <div className="w-56 shrink-0 border-r border-line flex flex-col">
          <div className="p-2 border-b border-line">
            <Button size="sm" className="w-full" icon={<Plus size={12} />} onClick={() => void create()}>
              New package
            </Button>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {list.map((p) => (
              <button key={p.name} className={cx('w-full text-left px-3 py-1.5 text-sm mono truncate flex items-center gap-2', sel === p.name ? 'bg-accent/10 text-accent' : 'hover:bg-hover')} onClick={() => setSel(p.name)}>
                <Package size={12} className="shrink-0 text-muted" />
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          {sel ? (
            <CodeEditor key={sel} language="javascript" value={code} onChange={setCode} />
          ) : (
            <Empty icon={<Package size={24} />} title={list.length ? 'Select a package' : 'No packages yet'}>
              Shared code for pre-request and test scripts, loaded with <code>pm.require('name')</code> as in Postman's package library. Scripts imported from Postman that use packages work once the packages are here.
            </Empty>
          )}
        </div>
      </div>
    </Modal>
  );
}
