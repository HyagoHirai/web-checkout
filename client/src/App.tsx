import { useSyncExternalStore } from 'react';
import { cartTotalMinor } from './machine/cart.ts';
import { inactivityDeadline, warningAt } from './machine/deadlines.ts';
import type { Runtime } from './machine/runtime.ts';
import { retainedSubmission } from './machine/submission.ts';
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

/** Maps the store's phase and screen to one screen component. Screens receive data and callbacks only. */
export function App({ runtime }: { runtime: Runtime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
  const actions = runtime.actions;
  const interaction = state.interaction;

  if (!interaction || interaction.phase === 'idle') return <Idle onStart={actions.start} />;

  const warnAt = warningAt(interaction);
  const deadline = inactivityDeadline(interaction);
  const showWarning = warnAt !== null && deadline !== null && state.now >= warnAt && interaction.phase !== 'confirmed';
  const secondsLeft = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - state.now) / 1000));
  const submission = interaction.submission;
  const recordedOrExpected = submission?.recordedTotalMinor ?? submission?.expectedTotalMinor ?? 0;

  const menuScreen = (
    <Menu menu={state.menu} loading={state.menuLoading} cart={state.cart} onAdd={actions.addItem} onSetQty={actions.setQty} onRemove={actions.removeItem} onReview={actions.goReview} onStartNew={actions.startNewOrder} />
  );

  let screen: React.ReactNode;
  switch (interaction.phase) {
    case 'submitted':
      screen = <Waiting onStartNew={actions.startNewOrder} />;
      break;
    case 'confirmed':
      screen = <Confirmed reference={submission?.reference ?? ''} totalMinor={recordedOrExpected} onDone={actions.done} />;
      break;
    case 'declined':
      screen = <Declined lines={submission?.lines ?? []} totalMinor={recordedOrExpected} onTryAgain={actions.retryPayment} onEdit={actions.goMenu} onStartNew={actions.startNewOrder} />;
      break;
    case 'unresolved':
      screen = <Unresolved knownState={submission?.knownState === 'pending' ? 'pending' : 'none'} reference={submission?.reference ?? null} onStartNew={actions.startNewOrder} />;
      break;
    case 'building':
      switch (interaction.screen) {
        case 'review':
          screen = <Review menu={state.menu} cart={state.cart} checking={state.activeCheck !== null} onConfirm={actions.goPayment} onBack={actions.goMenu} onStartNew={actions.startNewOrder} />;
          break;
        case 'payment':
          screen = (
            <Payment
              totalMinor={submission?.expectedTotalMinor ?? cartTotalMinor(state.cart, state.menu)}
              simulation={submission?.simulation ?? 'success'}
              onSetSimulation={actions.setSimulation}
              onPay={actions.pay}
              onBack={actions.backToCart}
              onStartNew={actions.startNewOrder}
            />
          );
          break;
        case 'rejected':
          screen = state.rejection ? <Rejected rejection={state.rejection} menu={state.menu} cart={state.cart} onReviewAgain={actions.tryAgain} onStartNew={actions.startNewOrder} /> : menuScreen;
          break;
        case 'error':
          screen = state.error ? (
            <ErrorScreen error={state.error} hasKeptKey={retainedSubmission(interaction) !== null} onTryAgain={actions.retryAfterError} onStartNew={actions.startNewOrder} />
          ) : menuScreen;
          break;
        default:
          screen = menuScreen;
      }
      break;
    default:
      screen = <Idle onStart={actions.start} />;
  }

  return (
    <>
      {screen}
      {showWarning && <InactivityWarning secondsLeft={secondsLeft} onContinue={actions.continueSession} onStartNew={actions.startNewOrder} />}
    </>
  );
}
