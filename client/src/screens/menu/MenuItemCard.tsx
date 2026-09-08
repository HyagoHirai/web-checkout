import type { MenuItem } from '../../../../shared/wire.ts';
import { MAX_QTY_PER_LINE } from '../../../../shared/constants.ts';
import { cartChangeBlocker } from '../../machine/cart.ts';
import { formatMinor } from '../../money/format.ts';
import type { Cart } from '../../machine/types.ts';

interface Props {
  item: MenuItem;
  cart: Cart;
  menu: MenuItem[] | null;
  onAdd: (id: string) => void;
}

/** One product and its add action. An unavailable item is listed and labelled but carries no control (FR-003). */
export function MenuItemCard({ item, cart, menu, onAdd }: Props) {
  if (!item.available) {
    return (
      <div className="item unavailable" data-item={item.id}>
        <div className="name">
          {item.name} <span className="badge">Unavailable</span>
        </div>
        <div className="row">
          <span className="price">{formatMinor(item.priceMinor)}</span>
        </div>
      </div>
    );
  }
  const existing = cart.lines.find((l) => l.itemId === item.id)?.quantity ?? 0;
  const blocker = cartChangeBlocker(cart, menu, item.id, existing + 1);
  return (
    <div className="item" data-item={item.id}>
      <div className="name">
        {item.name}
        {blocker === 'quantity_out_of_bounds' && <span className="badge" data-limit="quantity">Max {MAX_QTY_PER_LINE}</span>}
      </div>
      <div className="row">
        <span className="price">{formatMinor(item.priceMinor)}</span>
        <button onClick={() => onAdd(item.id)} disabled={blocker !== null} aria-label={`Add ${item.name}`}>
          + Add
        </button>
      </div>
    </div>
  );
}
