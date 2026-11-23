import type { Page } from '@playwright/test';
import { test, expect } from './support/test';
import { apiCreateProject, apiGet, apiRequest, picoToUsd, uniq, usdToPico, watchConsole } from './support/helpers';

/** hand-copied illustrative catalog prices ($ per 1M tokens as micro-USD per MTok); never imported from the app */
const PRICE: Record<string, [bigint, bigint, bigint]> = {
  'openai/gpt-4o': [2_500_000n, 10_000_000n, 1_250_000n],
  'openai/gpt-4o-mini': [120_000n, 500_000n, 60_000n], // v2 (current)
  'openai/gpt-4o-mini@v1': [150_000n, 600_000n, 75_000n],
  'openai/gpt-4.1': [2_000_000n, 8_000_000n, 500_000n],
  'openai/o3-mini': [1_100_000n, 4_400_000n, 550_000n],
  'anthropic/claude-opus': [15_000_000n, 75_000_000n, 1_500_000n],
  'anthropic/claude-sonnet': [3_000_000n, 15_000_000n, 300_000n],
  'anthropic/claude-haiku': [800_000n, 4_000_000n, 80_000n],
  fallback: [5_000_000n, 15_000_000n, 2_500_000n],
};
const costOf = (key: string, i: number, o: number, c: number) => {
  const [pi, po, pc] = PRICE[key];
  return { input: BigInt(i) * pi, output: BigInt(o) * po, cached: BigInt(c) * pc, total: BigInt(i) * pi + BigInt(o) * po + BigInt(c) * pc };
};
/** mirrors frontend fmtUsd(usd, 12): thousands separators, trailing zeros trimmed, at least 2 decimals */
function fmt12(pico: bigint): string {
  const usd = picoToUsd(pico);
  const [w, f] = usd.split('.');
  let frac = f.slice(0, 12).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `$${Number(w).toLocaleString('en-US')}.${frac}`;
}

async function calc(page: Page, opts: { provider?: string; model?: string; custom?: string; input: string; output: string; cached?: string; at?: string }) {
  if (opts.provider) await page.getByTestId('pricing-provider').selectOption(opts.provider);
  if (opts.model) await page.getByTestId('pricing-model').selectOption(opts.model);
  if (opts.custom !== undefined) { await page.getByTestId('pricing-model').selectOption('__custom__'); await page.getByTestId('pricing-custom-model').fill(opts.custom); }
  await page.getByTestId('pricing-input-tokens').fill(opts.input);
  await page.getByTestId('pricing-output-tokens').fill(opts.output);
  await page.getByTestId('pricing-cached-tokens').fill(opts.cached ?? '0');
  await page.getByTestId('pricing-at').fill(opts.at ?? '');
  await page.getByTestId('pricing-calc-submit').click();
}

test.describe('pricing & cost calculator', () => {
  test('calculator: exact BigInt costs, formulas, version used, raw strings; matches the API', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1, name: 'Pricing & Cost Calculator' })).toBeVisible();
    await expect(page.getByTestId('pricing-notice')).toContainText(/DEMO|SIMULATED|illustrative/i);

    const cases: Array<[string, string, number, number, number]> = [
      ['openai', 'gpt-4o', 1000, 500, 200],
      ['openai', 'gpt-4.1', 123_456, 7_890, 1_234],
      ['anthropic', 'claude-opus', 999_999, 1, 0],
      ['anthropic', 'claude-haiku', 3, 7, 11],
    ];
    for (const [provider, model, i, o, c] of cases) {
      await calc(page, { provider, model, input: String(i), output: String(o), cached: String(c) });
      const exp = costOf(`${provider}/${model}`, i, o, c);
      await expect(page.getByTestId('pricing-total')).toHaveText(fmt12(exp.total));
      await expect(page.getByTestId('pricing-input-cost')).toHaveText(fmt12(exp.input));
      await expect(page.getByTestId('pricing-output-cost')).toHaveText(fmt12(exp.output));
      await expect(page.getByTestId('pricing-cached-cost')).toHaveText(fmt12(exp.cached));
      await expect(page.getByTestId('pricing-total-cost')).toHaveText(fmt12(exp.total));
      await expect(page.getByTestId('pricing-cost-class')).toHaveText('SIMULATED');
      await expect(page.getByTestId('pricing-version-used')).toContainText(/Version v\d+/);
      await expect(page.getByTestId('pricing-formula-input')).toContainText(`${i.toLocaleString('en-US')} ×`);
      await expect(page.getByTestId('pricing-convention')).toContainText(/non-cached/i);
      // the raw 12-dp strings are exactly what the API returns
      await page.getByTestId('pricing-raw-toggle').check();
      await expect(page.getByTestId('pricing-total')).toHaveText(picoToUsd(exp.total));
      const api = await (await request.post('/api/cost/calculate', { data: { provider, model, inputTokens: i, outputTokens: o, cachedTokens: c } })).json();
      expect(api.data.totalCostUsd).toBe(picoToUsd(exp.total));
      expect(api.data.inputCostUsd).toBe(picoToUsd(exp.input));
      await page.getByTestId('pricing-raw-toggle').uncheck();
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('calculator: unknown / custom model is priced with the fallback row and labelled ESTIMATED', async ({ page }) => {
    await page.goto('/pricing');
    await calc(page, { custom: uniq('my-unknown-model'), input: '1000', output: '500' });
    const exp = costOf('fallback', 1000, 500, 0);
    await expect(page.getByTestId('pricing-cost-class')).toHaveText('ESTIMATED');
    await expect(page.getByTestId('pricing-total')).toHaveText(fmt12(exp.total));
    await expect(page.getByTestId('pricing-class-explanation')).toContainText('unknown to the catalog');
    await expect(page.getByTestId('pricing-version-used')).toContainText(/fallback/i);
  });

  test('calculator: "price as of" picks the pricing version effective then (gpt-4o-mini v1 vs v2); validation errors are inline', async ({ page }) => {
    await page.goto('/pricing');
    await calc(page, { provider: 'openai', model: 'gpt-4o-mini', input: '1000000', output: '1000000', cached: '1000000' });
    const now = costOf('openai/gpt-4o-mini', 1_000_000, 1_000_000, 1_000_000);
    await expect(page.getByTestId('pricing-total')).toHaveText(fmt12(now.total));
    const current = await page.getByTestId('pricing-version-used').innerText();
    await calc(page, { provider: 'openai', model: 'gpt-4o-mini', input: '1000000', output: '1000000', cached: '1000000', at: '2024-12-01T12:00' });
    const old = costOf('openai/gpt-4o-mini@v1', 1_000_000, 1_000_000, 1_000_000);
    await expect(page.getByTestId('pricing-total')).toHaveText(fmt12(old.total));
    expect(await page.getByTestId('pricing-version-used').innerText()).not.toBe(current);
    expect(old.total).not.toBe(now.total);

    // validation
    await page.getByTestId('pricing-input-tokens').fill('');
    await page.getByTestId('pricing-output-tokens').fill('12x');
    await page.getByTestId('pricing-cached-tokens').fill('-1');
    await page.getByTestId('pricing-calc-submit').click();
    await expect(page.getByTestId('pricing-input-error')).toHaveText('Required.');
    await expect(page.getByTestId('pricing-output-error')).toContainText('non-negative whole number');
    await expect(page.getByTestId('pricing-cached-error')).toContainText('non-negative whole number');
    await page.getByTestId('pricing-model').selectOption('__custom__');
    await page.getByTestId('pricing-custom-model').fill('');
    await page.getByTestId('pricing-calc-submit').click();
    await expect(page.getByTestId('pricing-model-error')).toBeVisible();
    // huge token counts stay exact
    await page.getByTestId('pricing-model').selectOption('gpt-4o');
    await page.getByTestId('pricing-input-tokens').fill('2000000000');
    await page.getByTestId('pricing-output-tokens').fill('1999999999');
    await page.getByTestId('pricing-cached-tokens').fill('7');
    await page.getByTestId('pricing-calc-submit').click();
    await expect(page.getByTestId('pricing-total')).toHaveText(fmt12(costOf('openai/gpt-4o', 2_000_000_000, 1_999_999_999, 7).total));
  });

  test('compare: every active model priced for the same workload, cheapest flagged, percentages exact, sortable', async ({ page, request }) => {
    const providers = await apiGet(request, '/api/providers');
    const active = providers.flatMap((p: any) => p.models.filter((m: any) => m.active).map((m: any) => `${p.key}/${m.name}`));
    await page.goto('/pricing?tab=compare');
    await page.getByTestId('pricing-input-tokens').count(); // (calculator inputs are not on this tab)
    await page.locator('#cmp-input').fill('50000');
    await page.locator('#cmp-output').fill('10000');
    await page.locator('#cmp-cached').fill('2000');
    await page.getByTestId('pricing-compare-submit').click();
    const rows = page.getByTestId('pricing-compare-row');
    await expect(rows).toHaveCount(active.length);

    const totals = new Map<string, bigint>();
    for (const key of active) {
      if (!PRICE[key]) continue; // models added by other specs are only checked for presence
      totals.set(key, costOf(key, 50_000, 10_000, 2_000).total);
    }
    const min = [...totals.values()].reduce((a, b) => (b < a ? b : a));
    const cheapestKeys = [...totals.entries()].filter(([, v]) => v === min).map(([k]) => k);
    for (const [key, total] of totals) {
      const [prov, model] = key.split('/');
      const row = rows.filter({ has: page.locator('td', { hasText: new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).filter({ hasText: prov });
      await expect(row, key).toHaveCount(1);
      await expect(row.getByTestId('pricing-compare-total')).toHaveText(fmt12(total));
      if (total === min) {
        await expect(row).toHaveAttribute('data-cheapest', 'true');
        await expect(row.getByTestId('pricing-compare-pct')).toHaveText('baseline');
      } else {
        await expect(row).toHaveAttribute('data-cheapest', 'false');
        const exact = Number(((total - min) * 10000n) / min) / 100;
        await expect(row.getByTestId('pricing-compare-pct')).toHaveText(`+${exact.toFixed(2)}%`);
      }
    }
    await expect(page.locator('[data-testid="pricing-compare-row"][data-cheapest="true"]')).toHaveCount(cheapestKeys.length);
    expect(cheapestKeys, 'the cheapest model of the illustrative catalog').toEqual(['openai/gpt-4o-mini']);
    await expect(rows.first()).toHaveAttribute('data-cheapest', 'true'); // default sort: cost ascending

    await page.getByTestId('pricing-sort-cost').click(); // descending
    await expect(rows.first()).toHaveAttribute('data-cheapest', 'false');
    await expect(rows.first().getByTestId('pricing-compare-total')).toHaveText(fmt12(costOf('anthropic/claude-opus', 50_000, 10_000, 2_000).total));
    await page.getByTestId('pricing-sort-model').click();
    await expect(rows.first()).toContainText('claude-haiku');
    // the compare tab validates token fields too
    await page.locator('#cmp-input').fill('abc');
    await page.getByTestId('pricing-compare-submit').click();
    await expect(page.getByTestId('pricing-input-error')).toBeVisible();
  });

  test('catalog: current prices + version history (immutable); fallback row is explained', async ({ page, request }) => {
    const rows = await apiGet(request, '/api/cost/pricing?history=true');
    const mini = rows.filter((r: any) => r.providerKey === 'openai' && r.modelName === 'gpt-4o-mini').sort((a: any, b: any) => a.version - b.version);
    expect(mini.length).toBeGreaterThanOrEqual(2);
    expect(mini.filter((r: any) => r.isCurrent)).toHaveLength(1);
    await page.goto('/pricing?tab=catalog');
    await page.getByTestId('pricing-catalog-model').fill('gpt-4o-mini');
    const row = page.locator('[data-testid="pricing-catalog-row"][data-model="gpt-4o-mini"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('current');
    await expect(row).toContainText(`v${mini[mini.length - 1].version}`);
    await row.getByTestId('pricing-history-toggle').click();
    await expect(page.getByTestId('pricing-history-row')).toHaveCount(mini.length);
    await expect(page.getByTestId('pricing-history-row').first()).toContainText(`v${mini[mini.length - 1].version}`); // newest first
    await expect(page.getByTestId('pricing-history-row').last()).toContainText('v1');
    await expect(page.getByTestId('pricing-history')).toContainText('superseded');
    await page.getByTestId('pricing-catalog-model').fill('');
    await expect(page.getByTestId('pricing-fallback-note')).toContainText('labeled ESTIMATED');
    await page.getByTestId('pricing-catalog-model').fill('definitely-no-such-model');
    await expect(page.getByTestId('pricing-catalog-row')).toHaveCount(0);
  });

  test('new version: validation, impact preview (exact), creation, history, and existing usage keeps its stored cost', async ({ page, request }) => {
    const errors = watchConsole(page);
    const model = uniq('e2e-priced').toLowerCase();
    const p = await apiCreateProject(request, uniq('Pricing Proj'));
    // usage BEFORE any version exists: unknown model -> fallback, ESTIMATED
    const before = await apiRequest(request, p.id, { model, maxOutputTokens: 100, prompt: 'pricing before' });
    const beforeUsage = (await apiGet(request, `/api/usage?projectId=${p.id}`))[0];
    expect(beforeUsage.costClass).toBe('ESTIMATED');
    expect(beforeUsage.costUsd).toBe(before.cost.totalCostUsd);

    await page.goto('/pricing?tab=new');
    await expect(page.getByTestId('pricing-new-warning')).toContainText('Existing usage events keep their stored cost');
    // validation (nothing is sent)
    await page.getByTestId('pricing-new-submit').click();
    await expect(page.getByTestId('pricing-new-provider-error')).toBeVisible();
    await expect(page.getByTestId('pricing-new-model-error')).toBeVisible();
    await expect(page.getByTestId('pricing-new-inP-error')).toBeVisible();
    await page.getByTestId('pricing-new-provider').fill('Bad Provider!');
    await page.getByTestId('pricing-new-model').fill(model);
    await page.getByTestId('pricing-new-input').fill('-1');
    await page.getByTestId('pricing-new-output').fill('1.1234567'); // more than 6 fraction digits
    await page.getByTestId('pricing-new-cached').fill('abc');
    await page.getByTestId('pricing-new-submit').click();
    await expect(page.getByTestId('pricing-new-provider-error')).toContainText('Lowercase slug');
    await expect(page.getByTestId('pricing-new-inP-error')).toContainText('at most 6 fraction digits');
    await expect(page.getByTestId('pricing-new-outP-error')).toContainText('at most 6 fraction digits');
    await expect(page.getByTestId('pricing-new-cachedP-error')).toContainText('at most 6 fraction digits');
    await expect(page.getByTestId('pricing-new-success')).toHaveCount(0);

    // valid v1 with impact preview: before = fallback (ESTIMATED), after = the entered prices
    await page.getByTestId('pricing-new-provider').fill('openai');
    await page.getByTestId('pricing-new-input').fill('1.5');
    await page.getByTestId('pricing-new-output').fill('3');
    await page.getByTestId('pricing-new-cached').fill('0.5');
    await expect(page.getByTestId('pricing-new-target-hint')).toContainText('creates v1');
    await page.getByTestId('pricing-new-note').fill('e2e v1');
    await page.getByTestId('pricing-new-preview').click();
    const beforePico = costOf('fallback', 10_000, 2_000, 1_000).total; // default sample 10000 / 2000 / 1000
    const afterPico = 10_000n * 1_500_000n + 2_000n * 3_000_000n + 1_000n * 500_000n;
    await expect(page.getByTestId('pricing-new-before')).toHaveText(fmt12(beforePico));
    await expect(page.getByTestId('pricing-new-after')).toHaveText(fmt12(afterPico));
    const delta = afterPico - beforePico;
    await expect(page.getByTestId('pricing-new-delta')).toContainText(`${delta < 0n ? '-' : '+'}${fmt12(delta < 0n ? -delta : delta)}`);
    await expect(page.getByTestId('pricing-new-preview-result')).toContainText('ESTIMATED');
    await page.getByTestId('pricing-new-submit').click();
    await expect(page.getByTestId('pricing-new-success')).toContainText(`openai / ${model} v1`);

    // the API agrees: v1 exists, is current, and new requests are priced with it (CATALOG), the OLD usage row is untouched
    const hist = await apiGet(request, `/api/cost/pricing?provider=openai&model=${model}&history=true`);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ version: 1, isCurrent: true, inputPerMTok: '1.500000', outputPerMTok: '3.000000', cachedPerMTok: '0.500000', note: 'e2e v1' });
    const after = await apiRequest(request, p.id, { model, maxOutputTokens: 100, prompt: 'pricing after' });
    expect(after.cost.costClass).not.toBe('ESTIMATED');
    const usage = await apiGet(request, `/api/usage?projectId=${p.id}`);
    const oldRow = usage.find((u: any) => u.id === before.usageEventId);
    expect(oldRow.costUsd).toBe(beforePicoUsd(oldRow));
    expect(oldRow.costUsd).toBe(beforeUsage.costUsd);
    expect(oldRow.costClass).toBe('ESTIMATED');
    expect(oldRow.pricingVersion).toBe(beforeUsage.pricingVersion);
    const newRow = usage.find((u: any) => u.id === after.usageEventId);
    expect(newRow.pricingVersion).toBe(1);
    const nPico = BigInt(newRow.inputTokens) * 1_500_000n + BigInt(newRow.outputTokens) * 3_000_000n + BigInt(newRow.cachedTokens) * 500_000n;
    expect(usdToPico(newRow.costUsd)).toBe(nPico);

    // v2 (higher price): preview now compares against v1, history shows both versions, the old version is unchanged
    await page.getByTestId('pricing-new-provider').fill('openai');
    await page.getByTestId('pricing-new-model').fill(model);
    await expect(page.getByTestId('pricing-new-target-hint')).toContainText('The new version will be v2');
    await page.getByTestId('pricing-new-copy').click();
    await expect(page.getByTestId('pricing-new-input')).toHaveValue('1.500000');
    await page.getByTestId('pricing-new-input').fill('3');
    await page.getByTestId('pricing-new-preview').click();
    const v1 = 10_000n * 1_500_000n + 2_000n * 3_000_000n + 1_000n * 500_000n;
    const v2 = 10_000n * 3_000_000n + 2_000n * 3_000_000n + 1_000n * 500_000n;
    await expect(page.getByTestId('pricing-new-before')).toHaveText(fmt12(v1));
    await expect(page.getByTestId('pricing-new-after')).toHaveText(fmt12(v2));
    await expect(page.getByTestId('pricing-new-delta')).toContainText('+');
    await page.getByTestId('pricing-new-submit').click();
    await expect(page.getByTestId('pricing-new-success')).toContainText('v2');
    const hist2 = await apiGet(request, `/api/cost/pricing?provider=openai&model=${model}&history=true`);
    expect(hist2).toHaveLength(2);
    const byVersion = Object.fromEntries(hist2.map((h: any) => [h.version, h]));
    expect(byVersion[1]).toMatchObject({ isCurrent: false, inputPerMTok: '1.500000' });
    expect(byVersion[2]).toMatchObject({ isCurrent: true, inputPerMTok: '3.000000' });
    const stillV1 = (await apiGet(request, `/api/usage?projectId=${p.id}`)).find((u: any) => u.id === after.usageEventId);
    expect(stillV1.costUsd).toBe(newRow.costUsd); // earlier usage is never re-priced
    expect(stillV1.pricingVersion).toBe(1);

    // the catalog tab lists both versions
    await page.getByTestId('pricing-tab-catalog').click();
    await page.getByTestId('pricing-catalog-model').fill(model);
    await page.locator(`[data-testid="pricing-catalog-row"][data-model="${model}"]`).getByTestId('pricing-history-toggle').click();
    await expect(page.getByTestId('pricing-history-row')).toHaveCount(2);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('API: pricing validation (bad slug, >6 decimals, negative, effectiveFrom before the latest version) is rejected with 400/409 and nothing is created', async ({ request }) => {
    const model = uniq('e2e-badprice').toLowerCase();
    const post = (data: object) => request.post('/api/cost/pricing', { data });
    const ok = { provider: 'openai', model, inputPerMTok: '1', outputPerMTok: '2', cachedPerMTok: '0.5' };
    for (const bad of [{ ...ok, provider: 'Bad Provider' }, { ...ok, inputPerMTok: '-1' }, { ...ok, outputPerMTok: '1.1234567' }, { ...ok, cachedPerMTok: 'NaN' }, { ...ok, model: '' }]) {
      expect((await post(bad)).status(), JSON.stringify(bad)).toBe(400);
    }
    expect((await post(ok)).status()).toBe(201);
    const earlier = await post({ ...ok, inputPerMTok: '9', effectiveFrom: '2001-01-01T00:00:00.000Z' });
    expect([400, 409]).toContain(earlier.status());
    expect(await apiGet(request, `/api/cost/pricing?provider=openai&model=${model}&history=true`)).toHaveLength(1);
  });
});

/** helper: recompute a stored usage row's cost from its own stored tokens with the fallback prices (ESTIMATED rows) */
function beforePicoUsd(row: { inputTokens: number; outputTokens: number; cachedTokens: number }): string {
  return picoToUsd(costOf('fallback', row.inputTokens, row.outputTokens, row.cachedTokens).total);
}
