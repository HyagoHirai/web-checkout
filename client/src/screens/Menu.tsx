import type { MenuItem } from '../../../shared/wire.ts';
import type { Cart } from '../machine/types.ts';
import { CartPanel } from './menu/CartPanel.tsx';
import { MenuItemCard } from './menu/MenuItemCard.tsx';

interface Props {
  menu: MenuItem[] | null;
  loading: boolean;
  cart: Cart;
  onAdd: (id: string) => void;
  onSetQty: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
  onReview: () => void;
  onStartNew: () => void;
}

/** S1: the catalogue on the left (available first, unavailable last), the order panel on the right. */
export function Menu({ menu, loading, cart, onAdd, onSetQty, onRemove, onReview, onStartNew }: Props) {
  const available = (menu ?? []).filter((m) => m.available);
  const unavailable = (menu ?? []).filter((m) => !m.available);

  return (
    <div className="screen" data-screen="menu">
      <header className="topbar">
        <h1>Choose your items</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="menu-layout">
          <section className="menu-scroll" aria-label="Menu">
            {cart.flagged.length > 0 && (
              <div className="notice bad" role="alert">
                An item in your order is no longer available. Remove it to continue; the rest of your order is kept.
              </div>
            )}
            {loading && !menu && <p className="hint">Loading the menu…</p>}
            <div className="menu">
              {available.map((m) => <MenuItemCard key={m.id} item={m} cart={cart} menu={menu} onAdd={onAdd} />)}
            </div>
            {unavailable.length > 0 && (
              <div className="menu unavailable-list" aria-label="Unavailable today">
                {unavailable.map((m) => <MenuItemCard key={m.id} item={m} cart={cart} menu={menu} onAdd={onAdd} />)}
              </div>
            )}
          </section>
          <CartPanel menu={menu} cart={cart} onSetQty={onSetQty} onRemove={onRemove} onReview={onReview} />
        </div>
      </div>
    </div>
  );
}
