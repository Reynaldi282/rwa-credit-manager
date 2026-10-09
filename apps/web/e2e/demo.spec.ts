import { expect, test, type Page } from "@playwright/test";

const pct = (s: string | null) => Number((s ?? "").replace(/[^0-9.]/g, ""));

async function stepDone(page: Page, n: number) {
  await expect(page.getByTestId(`demo-step-${n}`)).toHaveAttribute("data-done", "true", { timeout: 60_000 });
}

test("dashboard renders without a wallet", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("RWA Credit Manager");
  await expect(page.getByText("Protect Your Onchain Collateral")).toBeVisible();
  await expect(page.getByText(/Testnet demo\./)).toBeVisible();
  await expect(page.getByTestId("risk-simulator")).toBeVisible();
  // Simulator works on the sample position: -20% => 75% LTV, $160 repayment, 65% after.
  await expect(page.getByTestId("sim-ltv")).toContainText("75.00%");
  await expect(page.getByTestId("sim-repay")).toContainText("$160.00");
  await expect(page.getByTestId("sim-ltv-after")).toContainText("65.00%");
});

test("full demo: setup, price shock, on-chain protection via the UI", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("connector-dev").click();
  await expect(page.getByTestId("wallet-menu")).toBeVisible();

  // Fresh market (step 3) so the run is independent of earlier state.
  const before = await page.getByTestId("market-select").innerText();
  await page.getByTestId("demo-step-3-btn").click();
  await expect(page.getByTestId("market-select")).not.toHaveText(before, { timeout: 60_000 });

  await page.getByTestId("run-guided").click();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await stepDone(page, n);

  await expect(page.getByTestId("current-ltv")).toHaveText("60.00%");
  await expect(page.getByTestId("metric-debt")).toContainText("$1,200.00");
  await expect(page.getByTestId("metric-reserve")).toContainText("$200.00");
  await expect(page.getByTestId("protection-status")).toContainText("Armed");
  await expect(page.getByTestId("execute-protection")).toBeDisabled();

  // TEST oracle: -20%.
  await page.getByTestId("demo-step-8-btn").click();
  await stepDone(page, 8);
  await expect(page.getByTestId("metric-collateral-value")).toContainText("$1,600.00");

  // If a keeper is running it may protect first; otherwise use the button. Either way it is an on-chain tx.
  const exec = page.getByTestId("execute-protection");
  await expect(async () => {
    const ltv = pct(await page.getByTestId("current-ltv").innerText());
    if (ltv > 70 && (await exec.isEnabled())) await exec.click();
    expect(ltv).toBeLessThanOrEqual(65.01);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  await expect(page.getByTestId("current-ltv")).toHaveText(/^6[45]\.\d\d%$/);
  await expect(page.getByTestId("metric-debt")).toContainText("$1,040.00");
  await expect(page.getByTestId("metric-reserve")).toContainText("$40.00");
  const row = page.getByTestId("history-protection-executed").first();
  await expect(row).toContainText("repaid $160.00");
  await expect(row).toContainText("LTV 75.00% → 65.00%");
});
