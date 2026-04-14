const { chromium, devices } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices['iPhone 12'] });
  const page = await context.newPage();

  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });

  await page.locator('button.onboarding-cta').click();
  await page.locator('#login-email').fill('dan+ui-test@leepster.local');
  await page.locator('#login-password').fill('test1234');
  await page.route('**/api/users', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'ui-test',
        name: 'Dan Lee',
        email: 'dan+ui-test@leepster.local',
        plan: 'pro',
        createdAt: new Date().toISOString()
      })
    });
  });
  await page.locator('#login-submit-btn').click();

  const heading = page.locator('h2.tab-title');
  await heading.waitFor({ state: 'visible', timeout: 10000 });

  const nav = page.locator('.bottom-nav');
  const header = page.locator('.app-header');
  const viewportOk = await nav.isVisible() && await header.isVisible();

  console.log(JSON.stringify({
    ok: viewportOk,
    title: await heading.textContent(),
    navVisible: await nav.isVisible(),
    headerVisible: await header.isVisible(),
    viewport: page.viewportSize()
  }, null, 2));

  await page.screenshot({ path: 'mobile-ui-test.png', fullPage: true });
  await browser.close();
})();
