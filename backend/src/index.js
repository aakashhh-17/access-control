import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => console.log(`NFPL access-control API on :${config.port} (schema ${config.schema})`));
