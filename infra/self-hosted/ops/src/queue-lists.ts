// The two places this stack lists its queues in, read as the queue service
// and the shell read them: the `queues` block of its config, which creates
// queues, and the `queue` lines of init-aws.sh, which sets their attributes.

export type Queue = {
  visibility?: number;
  delay?: number;
  deadLetters?: { queue: string; receives: number };
};

export const configPath = new URL(
  '../config/elasticmq/elasticmq.conf',
  import.meta.url
);
export const scriptPath = new URL('../scripts/init-aws.sh', import.meta.url);

/** `300 seconds`, the form the config gives a duration in. */
function seconds(queue: string, value: string): number {
  const match = value.match(/^(\d+) seconds$/);
  if (!match) {
    throw new Error(`${queue}: not a number of seconds: ${value}`);
  }
  return Number(match[1]);
}

/** The `queues` block of the queue service's config. */
export function configQueues(text: string): {
  queues: Map<string, Queue>;
  fifo: Set<string>;
} {
  const start = text.indexOf('\nqueues {\n');
  if (start < 0) {
    throw new Error('elasticmq.conf has no queues block');
  }
  const lines = text
    .slice(start + '\nqueues {\n'.length)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '');

  const queues = new Map<string, Queue>();
  const fifo = new Set<string>();
  let name: string | undefined;
  let queue: Queue = {};
  let deadLetters: { queue?: string; receives?: number } | undefined;

  for (const line of lines) {
    if (name === undefined) {
      if (line === '}') {
        return { queues, fifo };
      }
      const opened = line.match(/^"?([a-z0-9.-]+)"? \{(\})?$/);
      if (!opened) {
        throw new Error(`not a queue: ${line}`);
      }
      if (opened[2]) {
        queues.set(opened[1], {});
      } else {
        name = opened[1];
        queue = {};
      }
      continue;
    }

    if (line === '}' && deadLetters === undefined) {
      queues.set(name, queue);
      name = undefined;
      continue;
    }
    if (line === 'deadLettersQueue {' && deadLetters === undefined) {
      deadLetters = {};
      continue;
    }

    const [key, value = ''] = line.split(' = ');
    if (deadLetters === undefined) {
      if (key === 'fifo' && value === 'true') {
        fifo.add(name);
      } else if (key === 'defaultVisibilityTimeout') {
        queue.visibility = seconds(name, value);
      } else if (key === 'delay') {
        queue.delay = seconds(name, value);
      } else {
        // Anything else is an attribute init-aws.sh has no column for.
        throw new Error(`${name}: not an attribute init-aws.sh sets: ${line}`);
      }
    } else if (line === '}') {
      if (deadLetters.queue === undefined || !deadLetters.receives) {
        throw new Error(`${name}: an incomplete dead-letter queue`);
      }
      queue.deadLetters = {
        queue: deadLetters.queue,
        receives: deadLetters.receives,
      };
      deadLetters = undefined;
    } else if (key === 'name') {
      deadLetters.queue = value.replace(/^"(.*)"$/, '$1');
    } else if (key === 'maxReceiveCount') {
      deadLetters.receives = Number(value);
    } else {
      throw new Error(`${name}: not a dead-letter setting: ${line}`);
    }
  }
  throw new Error('the queues block of elasticmq.conf does not end');
}

/** The `queue` lines of init-aws.sh, in their order. */
export function scriptQueues(text: string): Map<string, Queue> {
  const number = (field: string) => (field === '-' ? undefined : Number(field));
  const queues = new Map<string, Queue>();

  for (const match of text.matchAll(
    /^queue (\S+) (-|\d+) (-|\d+) (\S+) (-|\d+)$/gm
  )) {
    const [, name, visibility, delay, deadLetters, receives] = match;
    const queue: Queue = {};
    if (number(visibility) !== undefined) {
      queue.visibility = number(visibility);
    }
    if (number(delay) !== undefined) {
      queue.delay = number(delay);
    }
    if (deadLetters !== '-') {
      queue.deadLetters = { queue: deadLetters, receives: Number(receives) };
    }
    queues.set(name, queue);
  }
  return queues;
}
