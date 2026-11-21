// The one SQS call the ops containers make: SendMessage, in the JSON
// protocol the services' SDK speaks, through the same in-network endpoint.
// The queue service checks no signature, so the request carries none.

const ACCOUNT_ID = '000000000000';

export function queueUrl(awsUrl: string, queue: string): string {
  return `${awsUrl.replace(/\/+$/, '')}/${ACCOUNT_ID}/${queue}`;
}

/** Sends `body` to `queue`; rejects unless the queue service accepted it. */
export async function sendMessage(
  awsUrl: string,
  queue: string,
  body: string
): Promise<void> {
  const response = await fetch(awsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonSQS.SendMessage',
    },
    body: JSON.stringify({
      QueueUrl: queueUrl(awsUrl, queue),
      MessageBody: body,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `queue ${queue} refused the message: HTTP ${response.status} ${await response.text()}`
    );
  }
}
