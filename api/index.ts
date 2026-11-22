import express from 'express';
import { createApiRouter } from '../src/server/apiApp.ts';

const app = express();
app.use(createApiRouter());

export default app;
