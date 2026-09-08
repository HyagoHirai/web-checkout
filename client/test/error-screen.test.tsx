import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorScreen } from '../src/screens/Error.tsx';

describe('the error screen never claims nothing was charged while a retained key exists', () => {
  it('before any submission it may say nothing has been charged', () => {
    render(<ErrorScreen error={{ kind: 'menu_unreachable' }} hasKeptKey={false} onTryAgain={() => {}} onStartNew={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing has been charged/);
  });
  it.each(['menu_unreachable', 'bad_request', 'reference_exhausted', 'lookup_failed'] as const)('with a kept key (%s) it says the previous attempt is unchecked instead', (kind) => {
    render(<ErrorScreen error={{ kind }} hasKeptKey onTryAgain={() => {}} onStartNew={() => {}} />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).not.toMatch(/Nothing has been charged/);
    expect(text).toMatch(/previous attempt/);
  });
});
