import { defineAdapter, errors } from '@jackwener/browsermcp/adapter-sdk';

export default defineAdapter({
  description: 'X trending topics. Returns rank, topic, and category.',
  access: 'read',
  domain: 'x.com',
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'How many trends to return' },
  ],
  async run({ tab, args }) {
    const limit = Math.max(1, Number(args.limit) || 20);
    await tab.goto('https://x.com/explore/tabs/trending', { waitUntil: 'load', settleMs: 3000 });
    const trends = await tab.evaluate(`(() => {
      const items = [];
      for (const cell of document.querySelectorAll('[data-testid="trend"]')) {
        const text = cell.textContent || '';
        if (text.includes('Promoted')) continue;
        const container = cell.querySelector(':scope > div');
        if (!container) continue;
        const divs = container.children;
        if (divs.length < 2) continue;
        const topic = (divs[1].textContent || '').trim();
        if (!topic) continue;
        const category = (divs[0].textContent || '').trim().replace(/^\\d+\\s*/, '').replace(/^\\xB7\\s*/, '').trim();
        items.push({ rank: items.length + 1, topic, category });
      }
      return items;
    })()`);
    if (!Array.isArray(trends) || !trends.length) throw errors.empty('No trends found (the page structure may have changed)');
    return trends.slice(0, limit);
  },
});
