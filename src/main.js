import { config, WORK_TYPES } from './config.js';
import { muse, asList } from './muse.js';
import { currentRound, canSubmit } from './round.js';
import { claimedPmids, categoriesUsedThisEpoch, gradedFeedback, ours } from './ledger.js';
import { fetchAbstract } from './pubmed.js';
import { loadCatalogue, selectSources, catalogueStats } from './catalogue.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function fmt(n) { return String(n).padStart(3, ' '); }

async function status() {
  const [round, subsPayload, agents] = await Promise.all([
    currentRound(), muse.submissions(), muse.agents(),
  ]);

  console.log(`round ${round.id}  ${round.phase}  ${round.secondsRemaining}s left`);
  console.log(`latest closed epoch: ${round.latestClosedEpoch}`);
  console.log(`treasury: ${round.treasuryWei ?? 'unavailable'}`);

  const registered = asList(agents).some((a) => a.wallet === config.wallet);
  console.log(`\nagent ${config.handle}  registered=${registered}`);

  const mine = ours(subsPayload);
  console.log(`\nour submissions: ${mine.length}`);
  for (const s of mine.slice(0, 15)) {
    console.log(`  ${fmt(s.score ?? '—')}  ${String(s.workType).padEnd(19)} ${s.status.padEnd(10)} epoch ${s.epochId}`);
  }

  const feedback = gradedFeedback(subsPayload);
  if (feedback.length) {
    console.log('\ngraded feedback:');
    for (const f of feedback) {
      console.log(`  [${f.workType}] score=${f.score}`);
      if (f.reason) console.log(`     ${String(f.reason).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  } else {
    console.log('\ngraded feedback: none yet (scoring runs after the window closes)');
  }
  return { round, subsPayload };
}

/**
 * Picks the next category to work and a source nobody has claimed. Breadth
 * across categories is what pays: a second submission in a category already
 * used this epoch is worth zero.
 */
async function plan(round, subsPayload) {
  const used = categoriesUsedThisEpoch(subsPayload, round.id);
  const open = WORK_TYPES.filter((w) => !used.has(w));
  console.log(`\ncategories used this epoch: ${[...used].join(', ') || 'none'}`);
  console.log(`categories still open:      ${open.join(', ')}`);
  if (!open.length) return null;

  const claimed = claimedPmids(subsPayload);
  console.log(`PMIDs claimed network-wide: ${claimed.size}`);

  const catalogue = await loadCatalogue();
  const stats = catalogueStats(catalogue);
  console.log(`catalogue: ${stats.papers} papers, ${stats.trials} trials`);

  const ranked = selectSources(catalogue, claimed);
  console.log(`unclaimed candidates ranked: ${ranked.length}`);
  if (!ranked.length) return null;
  for (const r of ranked.slice(0, 3)) {
    console.log(`  [${r.evidenceLevel}] rank ${r.priorityRank}  ${String(r.title).slice(0, 70)}`);
  }

  // Catalogue metadata is a pointer, not evidence — read the real source.
  const record = await fetchAbstract(ranked[0].pmid);
  console.log(`\nselected PMID ${record.pmid}`);
  console.log(`  ${record.url}`);
  console.log(`  ${record.bytes} bytes  sha256=${record.sha256}`);
  return { workType: open[0], record, openCategories: open };
}

const { round, subsPayload } = await status();

if (args.has('--status')) process.exit(0);

const picked = await plan(round, subsPayload);
if (!picked) {
  console.log('\nnothing to do this round.');
  process.exit(0);
}

console.log(`\nwould submit as: ${picked.workType}`);
if (!canSubmit(round)) {
  console.log('window too close to the bell — holding.');
  process.exit(0);
}
if (dryRun) {
  console.log('dry run — not posting.');
  process.exit(0);
}
console.log('composing + posting is not wired yet (next step: src/compose.js).');
