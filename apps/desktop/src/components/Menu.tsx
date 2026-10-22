import { cloneElement, isValidElement, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { ChevronRight } from 'lucide-react';
import { cx } from '../lib/cx';
import { iconForLabel } from './action-icons';

const SUBMENU_ICON = <ChevronRight size={13} className="text-muted shrink-0" />;

/** The dropdown menu and its rows (ui.tsx re-exports them: a view imports them from there). */
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  danger?: boolean;
  shortcut?: string;
  disabled?: boolean;
  /** Why the item is disabled (its tooltip then): "Nothing is selected", "The proxy is running" … */
  reason?: string;
  /** Draw a separator above this item. */
  separator?: boolean;
  /** A tooltip (why the item is disabled, e.g. an environment whose file cannot be read). */
  title?: string;
  /** A submenu (e.g. Move to ▸ each collection); `onSelect` is then unused. */
  items?: MenuItem[];
}

/** F2 and Delete on a row run its menu's Rename and Delete items, the same as in a file tree. */
export function menuKeys(items: MenuItem[] | undefined) {
  return (e: React.KeyboardEvent) => {
    if (!items || (e.key !== 'F2' && e.key !== 'Delete')) return;
    // Delete deletes (it asks first); "Remove …" only when a row has no Delete (never "Remove from the collection")
    const usable = items.filter((i) => !i.disabled);
    const it = e.key === 'F2' ? usable.find((i) => /^Rename/.test(i.label)) : (usable.find((i) => /^Delete(…|$| )/.test(i.label)) ?? usable.find((i) => i.label.startsWith('Remove ') && !i.label.includes(' from ')));
    if (!it) return;
    e.preventDefault();
    it.onSelect();
  };
}

/**
 * Dropdown menu (keyboard navigable, animated). `trigger` must be a single focusable element.
 * Pass `open` / `onOpenChange` to control it, e.g. to open it from a right-click.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  width = 200,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  /** The items, or what builds them: a function is called only while the menu is open (a row of a long list builds nothing while closed). */
  items: MenuItem[] | (() => MenuItem[]);
  align?: 'start' | 'center' | 'end';
  width?: number;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  // an item that opens a dialog (Import, Rename …) must keep the focus there: giving it back to the menu's
  // button as the menu closes would count as a click outside the dialog, which then closes at once
  const picked = useRef(false);
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (v: boolean) => {
    setOwn(v);
    onOpenChange?.(v);
  };
  const buttonRef = useRef<HTMLElement>(null);
  // Closed, the menu is its button and nothing else. The menu machinery (portal, positioning, focus handling) is
  // mounted only while it is open: a tree of 500 requests has 500 of these menus, and mounting all of them made
  // every tab switch and every keystroke in the filter re-render them all.
  if (!isOpen && isValidElement(trigger)) {
    const t = trigger as ReactElement<Record<string, unknown>>;
    const props = t.props;
    const openIt = (e: ReactMouseEvent | ReactPointerEvent | ReactKeyboardEvent) => {
      if (e.defaultPrevented) return;
      // the same gestures as the menu itself: a main-button press, Enter, Space, or the down arrow
      if ('button' in e && (e.button !== 0 || (e as ReactPointerEvent).ctrlKey)) return;
      if ('key' in e && !['Enter', ' ', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      setOpen(true);
    };
    return cloneElement(t, {
      ref: buttonRef,
      'aria-haspopup': 'menu',
      'aria-expanded': false,
      'data-state': 'closed',
      onPointerDown: (e: ReactPointerEvent) => {
        (props.onPointerDown as ((e: ReactPointerEvent) => void) | undefined)?.(e);
        if (e.pointerType !== 'touch') openIt(e);
      },
      onClick: (e: ReactMouseEvent) => {
        (props.onClick as ((e: ReactMouseEvent) => void) | undefined)?.(e);
        // touch (and a synthetic click, as in tests): open on the click
        if (e.detail === 0 || (e.nativeEvent as PointerEvent).pointerType === 'touch') openIt(e);
      },
      onKeyDown: (e: ReactKeyboardEvent) => {
        (props.onKeyDown as ((e: ReactKeyboardEvent) => void) | undefined)?.(e);
        openIt(e);
      },
    } as Record<string, unknown>);
  }
  return (
    <MenuPrimitive.Root
      modal={false}
      open={isOpen}
      onOpenChange={(v) => {
        setOpen(v);
        // the menu's own button is a new element after closing: give it the focus back (unless an item took it)
        if (!v && !picked.current) requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
      }}
    >
      <MenuPrimitive.Trigger asChild>{isValidElement(trigger) ? cloneElement(trigger as ReactElement<Record<string, unknown>>, { ref: buttonRef } as Record<string, unknown>) : trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault();
            picked.current = false;
          }}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('[role=menuitem]')) picked.current = true;
          }}
          onKeyDownCapture={(e) => {
            if (e.key === 'Enter' || e.key === ' ') picked.current = true;
          }}
          // the menu is rendered elsewhere in the page, but React passes its events up to the component that owns it
          // (a tab, a tree row): a click on "Close all tabs" was also a click on the tab, which then opened again, and
          // Enter / Delete on an item reached the row's keys. What happens in a menu stays in the menu.
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onAuxClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          align={align}
          sideOffset={4}
          style={{ minWidth: width }}
          className="z-[70] rounded-xl border border-line bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
        >
          <MenuItems items={typeof items === 'function' ? items() : items} />
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/**
 * Run a menu item's action once the menu has closed. Radix calls `onSelect` inside `flushSync`, so a heavy action
 * (Expand all over thousands of rows) rendered synchronously while the menu was still open and blocked the click;
 * after a macrotask the menu is gone, its focus handled, and the action renders like any other click.
 */
function runSelected(onSelect: (() => void) | undefined) {
  if (onSelect) setTimeout(onSelect, 0);
}

const MENU_ROW = cx('flex items-center gap-2.5 rounded-md px-2 h-8 text-sm cursor-default select-none outline-none transition-colors', 'data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:opacity-50 data-[disabled]:pointer-events-none');

/** A menu's rows (and submenus, opened on hover or →). */
function MenuItems({ items: given }: { items: MenuItem[] }) {
  // a row without an icon of its own gets the one its label names, like buttons do
  const items = given.map((it) => (it.icon === undefined ? { ...it, icon: iconForLabel(it.label, it.danger ? 'danger' : undefined, { size: 14, fallback: false }) } : it));
  const icons = items.some((x) => x.icon);
  return (
    <>
      {items.map((it, i) => {
        const content = (
          <>
            {/* every row keeps the icon column so labels line up */}
            {(it.icon || icons) && <span className={cx('shrink-0 grid place-items-center w-4', it.danger ? 'text-bad' : 'text-muted')}>{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
            {/* the key as a hint drawn by CSS (menu-shortcut): the item's text stays its label alone */}
            {it.shortcut && <span className="text-xs text-muted menu-shortcut" data-shortcut={it.shortcut} />}
          </>
        );
        return (
          <div key={`${i}-${it.label}`} title={it.disabled && it.reason ? it.reason : it.title}>
            {it.separator && i > 0 && <MenuPrimitive.Separator className="my-1 h-px bg-line" />}
            {it.items ? (
              <MenuPrimitive.Sub>
                <MenuPrimitive.SubTrigger disabled={it.disabled || !it.items.length} className={cx(MENU_ROW, 'text-fg')}>
                  {content}
                  {SUBMENU_ICON}
                </MenuPrimitive.SubTrigger>
                <MenuPrimitive.Portal>
                  <MenuPrimitive.SubContent sideOffset={6} className="z-[71] min-w-[200px] max-w-[320px] max-h-[60vh] overflow-auto rounded-xl border border-line bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150">
                    <MenuItems items={it.items} />
                  </MenuPrimitive.SubContent>
                </MenuPrimitive.Portal>
              </MenuPrimitive.Sub>
            ) : (
              <MenuPrimitive.Item disabled={it.disabled} onSelect={() => runSelected(it.onSelect)} className={cx(MENU_ROW, it.danger ? 'text-bad data-[highlighted]:bg-bad/10' : 'text-fg')}>
                {content}
              </MenuPrimitive.Item>
            )}
          </div>
        );
      })}
    </>
  );
}
