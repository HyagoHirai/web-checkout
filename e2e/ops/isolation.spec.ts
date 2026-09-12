import { expect, test } from '@playwright/test';

/**
 * The operational acceptance must act on its own compose project only. A
 * configured webServer would run `docker compose up --build` on the DEMO stack whenever the demo URL
 * is down (for example, an API stopped on purpose for a presentation) before these tests even start.
 */
test('the ops project runs with no webServer configured', () => {
  expect(test.info().config.webServer).toBeNull();
});
