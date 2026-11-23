// A child that answers with something that is not an outcome.
import { stdout, write } from 'bun';
await write(stdout, '{"ok":true,"value":{"type":"pdf"}}');
process.exit(0);
