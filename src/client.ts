import { DEFAULT_INTENTS, DEFAULT_PARTIALS } from '@utils/constants.ts';
import { Client } from 'discordx';

export const client = new Client({
  'intents': [...DEFAULT_INTENTS],
  'partials': [...DEFAULT_PARTIALS],
});
