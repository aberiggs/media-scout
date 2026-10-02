import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { buildStack } from './compose';
import { loadConfig } from './config';
import type { PreparedOperatorAction } from './core/operator-actions';

export async function runOperatorCli(stack: ReturnType<typeof buildStack>): Promise<void> {
  stack = stack.createSnapshot(stack.state.getSettings());
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Operator CLI requires an interactive TTY');
  if (!stack.config.ALLOW_OPERATOR_ACTIONS) throw new Error('Operator actions are disabled; enable allowOperatorActions in the web settings first');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reviews = stack.state.listManualReview(false);
    if (reviews.length === 0) { console.log('No open reviews.'); return; }
    console.log('Open reviews:');
    reviews.forEach((review, index) => console.log(`${index}: ${review.id} — ${review.reason} — ${review.workKey}`));
    const reviewIndex = await chooseNumber(prompt, 'Review number (or cancel): ', reviews.length);
    if (reviewIndex === null) return;
    const review = reviews[reviewIndex]!;
    const operations = [{ value: 'associate_queue' as const, label: 'Associate queue' }, ...(review.subjectKind === 'intent' ? [{ value: 'release_intent_hold' as const, label: 'Release intent hold' }] : [])];
    console.log('Actions:');
    operations.forEach((operation, index) => console.log(`${index}: ${operation.label}`));
    const operationIndex = await chooseNumber(prompt, 'Action number (or cancel): ', operations.length);
    if (operationIndex === null) return;
    const operation = operations[operationIndex]!.value;
    const prepared = await withFreshOperatorActions(stack, (actions) => actions.prepareReviewAction({ reviewId: review.id, operation }));
    printPrepared(prepared);
    let result: unknown;
    if (operation === 'associate_queue') {
      const choices = prepared.associationChoices;
      if (!choices) throw new Error('Association preview is missing supplied choices');
      const mediaIndex = await chooseNumber(prompt, 'Media index (or cancel): ', choices.media.length);
      if (mediaIndex === null) return;
      const allowedTargets = choices.targets;
      const selectedTargets = await chooseTargetIndices(prompt, allowedTargets);
      if (selectedTargets === null) return;
      const challengeResponse = await prompt.question('Type the exact challenge text to authorize: ');
      const note = await prompt.question('Audit note (3-500 printable characters): ');
      result = await withFreshOperatorActions(stack, (actions) => actions.associateQueue({ reviewId: review.id, token: prepared.token, proposedAssociation: { mediaIndex, targetIndices: selectedTargets }, challengeResponse, note }));
    } else {
      const challengeResponse = await prompt.question('Type the exact challenge text to authorize: ');
      const note = await prompt.question('Audit note (3-500 printable characters): ');
      result = await withFreshOperatorActions(stack, (actions) => actions.releaseIntentHold({ reviewId: review.id, token: prepared.token, challengeResponse, note }));
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    prompt.close();
  }
}

/** Take one coherent DB settings snapshot immediately before each operator service call. */
export async function withFreshOperatorActions<T>(
  stack: ReturnType<typeof buildStack>,
  action: (actions: ReturnType<typeof buildStack>['operatorActions']) => Promise<T>,
): Promise<T> {
  const current = stack.createSnapshot(stack.state.getSettings());
  if (!current.config.ALLOW_OPERATOR_ACTIONS) throw new Error('Operator actions are disabled; enable allowOperatorActions in the web settings first');
  return action(current.operatorActions);
}

function printPrepared(prepared: PreparedOperatorAction): void {
  console.log(`\nPrepared ${prepared.operation} for review ${prepared.reviewId}`);
  console.log(`Targets: ${prepared.targetNames.join(', ')}`);
  console.log(`Expires: ${prepared.expiresAt}`);
  console.log(`One-time token: ${prepared.token}`);
  console.log(`Exact challenge: ${prepared.challenge}`);
  if (prepared.queuePreview) console.log(`Queue row: ${prepared.queuePreview.title ?? '[untitled]'} (${prepared.queuePreview.status ?? 'status unknown'})`);
  if (prepared.associationChoices) {
    console.log('Supplied media choices:');
    prepared.associationChoices.media.forEach(({ index, title }) => console.log(`  ${index}: ${title}`));
    console.log('Supplied target choices:');
    prepared.associationChoices.targets.forEach(({ index, title }) => console.log(`  ${index}: ${title}`));
  }
}

async function chooseNumber(prompt: ReturnType<typeof createInterface>, label: string, length: number): Promise<number | null> {
  const answer = (await prompt.question(label)).trim();
  if (answer.toLowerCase() === 'cancel') return null;
  if (!/^\d+$/u.test(answer)) throw new Error('Enter a listed numeric index or cancel');
  const value = Number(answer);
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) throw new Error('Index is outside the listed choices');
  return value;
}

async function chooseTargetIndices(prompt: ReturnType<typeof createInterface>, targets: Array<{ index: number; title: string }>): Promise<number[] | null> {
  const allowed = targets.map(({ index }) => index);
  const answer = (await prompt.question('Target index (or comma-separated indices; cancel to abort): ')).trim();
  if (answer.toLowerCase() === 'cancel') return null;
  const values = answer.split(',').map((part) => part.trim());
  if (!values.length || values.some((part) => !/^\d+$/u.test(part))) throw new Error('Enter listed numeric indices or cancel');
  const selected = values.map(Number);
  if (new Set(selected).size !== selected.length || selected.some((index) => !allowed.includes(index))) throw new Error('Target index is outside the permitted review scope');
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Operator CLI requires an interactive TTY');
  const config = loadConfig();
  const stack = buildStack({ config });
  await runOperatorCli(stack);
}
