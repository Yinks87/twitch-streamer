import express from "express";
import twitchAuthRouter from "./api_v1/twitch-auth.js";
import twitchApiRouter from "./api_v1/twitch-api.js";
import videosRouter from './api_v1/videos.js';
import playlistRouter from './api_v1/playlist.js';
import settingsRouter from './api_v1/settings.js';
import streamRouter from './api_v1/stream.js';
import usersRouter from './api_v1/users.js';

const baseRouter = express.Router();

baseRouter.use("/api/v1/auth", twitchAuthRouter);
baseRouter.use('/api/v1', videosRouter);
baseRouter.use('/api/v1', twitchApiRouter);
baseRouter.use('/api/v1', playlistRouter);
baseRouter.use('/api/v1', settingsRouter);
baseRouter.use('/api/v1', streamRouter);
baseRouter.use('/api/v1', usersRouter);

export default baseRouter;

