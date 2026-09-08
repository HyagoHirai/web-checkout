import { useSyncExternalStore } from 'react';
import { warningAt, inactivityDeadline } from './machine/deadlines.ts';
import type { Runtime } from './machine/runtime.ts';
import { cartTotalMinor } from './machine/reducer.ts';
import { Idle } from './screens/Idle.tsx';
import { Menu } from './screens/Menu.tsx';
import { Review } from './screens/Review.tsx';
import { Payment } from './screens/Payment.tsx';
import { Waiting } from './screens/Waiting.tsx';
import { Confirmed } from './screens/Confirmed.tsx';
import { Declined } from './screens/Declined.tsx';
import { Unresolved } from './screens/Unresolved.tsx';
import { Rejected } from './screens/Rejected.tsx';
import { ErrorScreen } from './screens/Error.tsx';
import { InactivityWarning } from './screens/InactivityWarning.tsx';

export function App({ runtime }: { runtime: Runtime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
  const a = runtime.actions;
  const i = state.interaction;

  if (!i || i.phase === 'idle') return <Idle onStart={a.start} />;

  const warnAt = warningAt(i);
  const deadline = inactivityDeadline(i);
  const showWarning = warnAt !== null && deadline !== null && state.now >= warnAt && i.phase !== 'confirmed';
  const secondsLeft = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - state.now) / 1000));

  let screen: React.ReactNode;
  switch (i.phase) {
    case 'submitted':
      screen = <Waiting onStartNew={a.startNewOrder} />;
      break;
    case 'confirmed':
      screen = <Confirmed reference={i.submission?.reference ?? ''} totalMinor={i.submission?.recordedTotalMinor ?? i.submission?.expectedTotalMinor ?? 0} onDone={a.done} />;
      break;
    case 'declined':
      screen = <Declined lines={i.submission?.lines ?? []} totalMinor={i.submission?.recordedTotalMinor ?? i.submission?.expectedTotalMinor ?? 0} onTryAgain={a.tryAgain} onEdit={a.goMenu} onStartNew={a.startNewOrder} />;
      break;
    case 'unresolved':
      screen = <Unresolved knownState={i.submission?.knownState === 'pending' ? 'pending' : 'none'} reference={i.submission?.reference ?? null} onStartNew={a.startNewOrder} />;
      break;
    case 'building':
      switch (i.screen) {
        case 'review':
          screen = <Review menu={state.menu} cart={state.cart} checking={state.checkingKey} onConfirm={a.goPayment} onBack={a.goMenu} onStartNew={a.startNewOrder} />;
          break;
        case 'payment':
          screen = (
            <Payment
              totalMinor={i.submission?.expectedTotalMinor ?? cartTotalMinor(state.cart, state.menu)}
              simulation={i.submission?.simulation ?? 'success'}
              onSetSimulation={a.setSimulation}
              onPay={a.pay}
              onBack={a.backToCart}
              onStartNew={a.startNewOrder}
            />
          );
          break;
        case 'rejected':
          screen = state.rejection ? (
            <Rejected rejection={state.rejection} menu={state.menu} cart={state.cart} onReviewAgain={a.tryAgain} onStartNew={a.startNewOrder} />
          ) : (
            <Menu menu={state.menu} loading={state.menuLoading} cart={state.cart} onAdd={a.addItem} onSetQty={a.setQty} onRemove={a.removeItem} onReview={a.goReview} onStartNew={a.startNewOrder} />
          );
          break;
        case 'error':
          screen = state.error ? (
            <ErrorScreen error={state.error} onTryAgain={a.retryAfterError} onStartNew={a.startNewOrder} />
          ) : (
            <Menu menu={state.menu} loading={state.menuLoading} cart={state.cart} onAdd={a.addItem} onSetQty={a.setQty} onRemove={a.removeItem} onReview={a.goReview} onStartNew={a.startNewOrder} />
          );
          break;
        default:
          screen = <Menu menu={state.menu} loading={state.menuLoading} cart={state.cart} onAdd={a.addItem} onSetQty={a.setQty} onRemove={a.removeItem} onReview={a.goReview} onStartNew={a.startNewOrder} />;
      }
      break;
    default:
      screen = <Idle onStart={a.start} />;
  }

  return (
    <>
      {screen}
      {showWarning && <InactivityWarning secondsLeft={secondsLeft} onContinue={a.continueSession} onStartNew={a.startNewOrder} />}
    </>
  );
}
