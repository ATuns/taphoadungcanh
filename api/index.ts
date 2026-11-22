import express from 'express';
import { createApiRouter } from '../src/server/apiApp.js';

const app = express();
app.use(createApiRouter());

export default app;
