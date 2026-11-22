// init-aws.sh runs on every deployment, before any service, and a deployment
// stops where it stops. Its queue part is run here against a stand-in for the
// AWS CLI that keeps a list of queues and records each call, so what it asks
// of the queue service is known before a deployment asks it.

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { file, spawn } from 'bun';
import { expect, test } from 'bun:test';
import {
  configPath,
  configQueues,
  type Queue,
  scriptPath,
} from './queue-lists';

const QUEUE_URL = 'http://localstack:4566/000000000000/';

// The calls whose answer the script reads are answered; every other call
// succeeds. A call is recorded as its arguments, separated by the unit
// separator, on one line.
const STAND_IN = `#!/bin/sh
{ printf '%s\\037' "$@"; printf '\\n'; } >> "$STAND_IN_CALLS"
shift 2
case "$1 $2" in
  'sqs list-queues')
    if [ -s "$STAND_IN_QUEUES" ]; then
      tr '\\n' '\\t' < "$STAND_IN_QUEUES"
      echo
    else
      echo None
    fi
    ;;
  'sqs create-queue')
    echo "${QUEUE_URL}$4" >> "$STAND_IN_QUEUES"
    ;;
  'sqs get-queue-attributes')
    echo 0
    ;;
esac
if [ "$2" = "$STAND_IN_REFUSES" ]; then
  echo "refused" >&2
  exit 254
fi
`;

type Run = {
  exitCode: number;
  output: string;
  /** The queue calls, in order, without the endpoint. */
  calls: string[][];
  /** The queues the queue service has afterwards. */
  queues: string[];
};

/** Runs init-aws.sh against a queue service that has `existing`. */
async function run(
  existing: string[],
  options: { refuses?: string; twice?: boolean } = {}
): Promise<Run> {
  const directory = mkdtempSync(join(tmpdir(), 'init-aws-'));
  try {
    const queuesFile = join(directory, 'queues');
    const callsFile = join(directory, 'calls');
    writeFileSync(join(directory, 'aws'), STAND_IN);
    chmodSync(join(directory, 'aws'), 0o755);
    writeFileSync(
      queuesFile,
      existing.map((name) => `${QUEUE_URL}${name}\n`).join('')
    );

    let exitCode = 0;
    let output = '';
    for (let round = 0; round < (options.twice ? 2 : 1); round++) {
      writeFileSync(callsFile, '');
      const script = spawn(['sh', fileURLToPath(scriptPath)], {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          LOCAL_AWS_URL: 'http://localstack:4566',
          STAND_IN_QUEUES: queuesFile,
          STAND_IN_CALLS: callsFile,
          STAND_IN_REFUSES: options.refuses ?? '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      output = await new Response(script.stdout).text();
      exitCode = await script.exited;
    }

    const lines = (path: string) =>
      readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return {
      exitCode,
      output,
      calls: lines(callsFile)
        .map((line) => line.split('\x1f').slice(2, -1))
        .filter(([service]) => service === 'sqs'),
      queues: lines(queuesFile).map((url) => url.slice(QUEUE_URL.length)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The value a call gives an option. */
function option(call: string[], name: string): string {
  return call[call.indexOf(name) + 1];
}

/**
 * The attributes the calls leave each queue with, as the queue service would
 * take them: a call that names a queue, or a dead-letter queue, that does not
 * exist at that point is refused there, so it fails here.
 */
function attributesSet(
  existing: string[],
  calls: string[][]
): Map<string, Queue> {
  const there = new Set(existing);
  const set = new Map<string, Queue>();

  for (const call of calls) {
    if (call[1] === 'create-queue') {
      const name = option(call, '--queue-name');
      // FIFO cannot be set later, and the name has to say it.
      expect(call.includes('FifoQueue=true')).toBe(name.endsWith('.fifo'));
      there.add(name);
    } else if (call[1] === 'set-queue-attributes') {
      const name = option(call, '--queue-url').slice(QUEUE_URL.length);
      expect(there.has(name)).toBe(true);

      const attributes: Record<string, string> = JSON.parse(
        option(call, '--attributes')
      );
      const queue: Queue = {};
      for (const [attribute, value] of Object.entries(attributes)) {
        if (attribute === 'VisibilityTimeout') {
          queue.visibility = Number(value);
        } else if (attribute === 'DelaySeconds') {
          queue.delay = Number(value);
        } else if (attribute === 'RedrivePolicy') {
          const policy = JSON.parse(value);
          const deadLetters = policy.deadLetterTargetArn.replace(
            'arn:aws:sqs:us-east-1:000000000000:',
            ''
          );
          expect(there.has(deadLetters)).toBe(true);
          queue.deadLetters = {
            queue: deadLetters,
            receives: policy.maxReceiveCount,
          };
        } else {
          throw new Error(`${name}: ${attribute} is not one the stack sets`);
        }
      }
      set.set(name, queue);
    }
  }
  return set;
}

/** The queues of the config that have an attribute to set. */
async function configured(): Promise<{
  names: string[];
  attributes: [string, Queue][];
}> {
  const { queues } = configQueues(await file(configPath).text());
  return {
    names: [...queues.keys()].sort(),
    attributes: [...queues]
      .filter(([, queue]) => Object.keys(queue).length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

function created(calls: string[][]): string[] {
  return calls
    .filter((call) => call[1] === 'create-queue')
    .map((call) => option(call, '--queue-name'));
}

test('on an empty queue service every queue of the config is created and its attributes are set', async () => {
  const { names, attributes } = await configured();

  const first = await run([]);

  expect(first.exitCode).toBe(0);
  expect(first.queues.sort()).toEqual(names);
  expect(
    [...attributesSet([], first.calls)].sort(([a], [b]) => a.localeCompare(b))
  ).toEqual(attributes);
});

test('a queue that is there is not created again, and gets the attributes all the same', async () => {
  const { names, attributes } = await configured();
  // A queue as an earlier deployment made it: there, with the defaults.
  const existing = ['email-service-refresh-queue', 'search-event-queue'];

  const upgrade = await run(existing);

  expect(upgrade.exitCode).toBe(0);
  expect(
    created(upgrade.calls).filter((name) => existing.includes(name))
  ).toEqual([]);
  expect(upgrade.queues.sort()).toEqual(names);
  expect(
    [...attributesSet(existing, upgrade.calls)].sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ).toEqual(attributes);
});

test('a second run creates nothing and sets the same attributes', async () => {
  const { names, attributes } = await configured();

  const second = await run([], { twice: true });

  expect(second.exitCode).toBe(0);
  expect(created(second.calls)).toEqual([]);
  expect(second.queues.sort()).toEqual(names);
  expect(
    [...attributesSet(names, second.calls)].sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ).toEqual(attributes);
});

test('the job fails when the queue service refuses a queue or an attribute', async () => {
  const refusedQueue = await run([], { refuses: 'create-queue' });
  const refusedAttribute = await run([], { refuses: 'set-queue-attributes' });

  expect(refusedQueue.exitCode).not.toBe(0);
  expect(refusedAttribute.exitCode).not.toBe(0);
  expect(refusedAttribute.output).not.toContain('are in place');
});

test('the job reports each dead-letter queue, and goes on when it cannot count one', async () => {
  const counted = await run([]);
  const uncounted = await run([], { refuses: 'get-queue-attributes' });

  expect(counted.output).toContain(
    'dead-letter queue contacts-dlq holds 0 messages'
  );
  expect(uncounted.exitCode).toBe(0);
  expect(uncounted.output).toContain(
    'dead-letter queue contacts-dlq holds unknown messages'
  );
});
