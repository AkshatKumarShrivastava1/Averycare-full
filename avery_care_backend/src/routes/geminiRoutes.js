import express from 'express';
import { generateChatReply } from '../controllers/geminiContoller.js';
import {protect} from '../middlewares/authMiddleware.js';
const router = express.Router();

router.post('/chat', protect, generateChatReply);

export default router;