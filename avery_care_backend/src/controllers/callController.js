import pkg from 'twilio';
const { twiml } = pkg;
import { GoogleGenerativeAI } from "@google/generative-ai";
import ScheduledCall from '../models/scheduledCallSummary.js';
import User from '../models/User.js';
import twilioClient from '../config/twilio.js';
import { scheduleNewCall } from '../jobs/callScheduler.js';
import FamilyMember from '../models/FamilyMember.js';
import { cancelScheduledCall } from '../jobs/callScheduler.js';
import { isValidISOStringDate } from '../utils/validationUtils.js';

if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY .env file mein set nahi hai.');
}
import { isValidObjectId } from '../utils/validationUtils.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiVoiceModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    generationConfig: {
        maxOutputTokens: 70,
        temperature: 0.7,
    },
    systemInstruction: "You are a friendly and caring health assistant AI of Avery Care on a live phone call. Check in warmly on the user's health and well-being. Never provide medical advice. Keep your response strictly under 2 short conversational sentences (maximum 30 words) so it is clear and quick to speak over the phone."
});

const geminiSummarizerModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.4,
    },
    systemInstruction: "You are a friendly health assistant summarizer. Summarize the conversation in 2-3 concise sentences. Be empathetic, avoid medical advice."
});

const conversationHistories = new Map();

async function getOrCreateConversationHistory(callSid, callId) {
    if (callSid && conversationHistories.has(callSid)) {
        return conversationHistories.get(callSid);
    }
    // Restore from database if callId is available (e.g. server reload)
    if (callId && isValidObjectId(callId)) {
        try {
            const callDoc = await ScheduledCall.findById(callId).select('transcript');
            if (callDoc && callDoc.transcript && callDoc.transcript.length > 0) {
                const restored = [];
                for (const item of callDoc.transcript) {
                    const role = item.role === 'assistant' ? 'model' : 'user';
                    // Multi-turn chat must start with user turn
                    if (restored.length === 0 && role !== 'user') {
                        continue;
                    }
                    if (restored.length > 0 && restored[restored.length - 1].role === role) {
                        restored[restored.length - 1].parts[0].text += ` ${item.message}`;
                    } else {
                        restored.push({
                            role: role,
                            parts: [{ text: item.message }]
                        });
                    }
                }
                if (callSid) conversationHistories.set(callSid, restored);
                return restored;
            }
        } catch (dbErr) {
            console.error('Failed to restore conversation history from DB:', dbErr.message);
        }
    }
    const empty = [];
    if (callSid) conversationHistories.set(callSid, empty);
    return empty;
}

async function getFastGeminiReply(chat, prompt, fallbackText) {
    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), 7000)
        );
        const result = await Promise.race([
            chat.sendMessage(prompt),
            timeoutPromise
        ]);
        return result.response.text();
    } catch (err) {
        console.error('Gemini call failed or timed out:', err.message);
        return fallbackText;
    }
}

export const triggerCall = async (phoneNumber, callId) => {
    try {
        if (!callId || !isValidObjectId(callId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID format",
            });
        }
        console.log(`Controller: triggerCall function shuru. Phone number: ${phoneNumber}, Call ID: ${callId}`);
        const publicUrl = (process.env.PUBLIC_URL || '').trim();
        const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();
        const voiceUrl = `${publicUrl}/api/calls/voice?callId=${callId}`;
        const statusCallbackUrl = `${publicUrl}/api/calls/status`;
        console.log(`Controller: Twilio call jaa rahi hai. Webhook URL: ${voiceUrl}, Status Callback: ${statusCallbackUrl}`);

        const call = await twilioClient.calls.create({
            url: voiceUrl,
            to: phoneNumber,
            from: fromNumber,
            statusCallback: statusCallbackUrl,
        });

        console.log(`Controller: Twilio call shuru ho gayi. SID: ${call.sid}`);

        await ScheduledCall.findByIdAndUpdate(callId, {
            status: 'in-progress',
            callSid: call.sid,
            startTime: new Date(),
        });
        console.log(`Controller: Database mein Call ID ${callId} updated.`);

        return call.sid;
    } catch (error) {
        console.error(`Controller: triggerCall mein ERROR: ${error.message}`);
        throw error;
    }
};

export const makeCall = async (req, res) => {
    try {
        console.log("Controller: makeCall API hit hua.");
        const { to } = req.body;
        if (!to) {
            console.error('Controller: "to" phone number missing hai.');
            return res.status(400).json({ message: '"to" phone number zaroori hai.' });
        }
        const callSid = await triggerCall(to);
        res.status(200).json({ message: `Call shuru ho gayi. SID: ${callSid}` });
    } catch (error) {
        console.error('Controller: makeCall controller mein ERROR:', error);
        res.status(500).json({ message: 'Call shuru karne mein fail hua.' });
    }
};

export const handleVoice = async (req, res) => {
    const twimlResponse = new twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const callId = req.query.callId;
    const publicUrl = (process.env.PUBLIC_URL || '').trim();

    try {
        console.log(`Controller: handleVoice webhook hit. Call SID: ${callSid}, Call ID: ${callId}`);
        const history = await getOrCreateConversationHistory(callSid, callId);

        const chat = geminiVoiceModel.startChat({ history });

        console.log("Controller: Gemini se pehla message generate kar rahe hain...");
        const aiResponse = await getFastGeminiReply(
            chat,
            "Start the conversation by introducing yourself as Avery Care assistant and asking how I am feeling today in one short sentence.",
            "Hi there! I'm your Avery Care assistant. I'm just checking in to see how you're doing today—how are you feeling?"
        );
        console.log(`Controller: Gemini ka pehla sandesh: "${aiResponse}"`);

        try {
            const updatedHistory = await chat.getHistory();
            if (callSid) conversationHistories.set(callSid, updatedHistory);
        } catch (hErr) {
            console.warn('Could not update history from chat session:', hErr.message);
        }

        if (callId && isValidObjectId(callId)) {
            await ScheduledCall.findByIdAndUpdate(callId, {
                $push: { transcript: { role: 'assistant', message: aiResponse } }
            }).catch(e => console.error('DB update error in handleVoice:', e.message));
            console.log(`Controller: Database mein AI ka pehla message store hua.`);
        }

        const gather = twimlResponse.gather({
            input: 'speech',
            timeout: 5,
            speechTimeout: 'auto',
            action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
            method: 'POST',
        });

        gather.say({ voice: 'Polly.Joanna' }, aiResponse);

        // If user didn't speak after greeting
        twimlResponse.say({ voice: 'Polly.Joanna' }, "Are you still there? How are you feeling today?");
        twimlResponse.gather({
            input: 'speech',
            timeout: 5,
            speechTimeout: 'auto',
            action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
            method: 'POST',
        });
        twimlResponse.say({ voice: 'Polly.Joanna' }, "I'll check in with you later. Take care and goodbye!");
        twimlResponse.hangup();

        res.type('text/xml').status(200).send(twimlResponse.toString());
    } catch (error) {
        console.error('Controller: handleVoice webhook mein ERROR:', error);
        const errorResponse = new twiml.VoiceResponse();
        const gather = errorResponse.gather({
            input: 'speech',
            timeout: 5,
            speechTimeout: 'auto',
            action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
            method: 'POST',
        });
        gather.say({ voice: 'Polly.Joanna' }, "Hi there! I am your Avery Care assistant. How are you feeling today?");
        errorResponse.say({ voice: 'Polly.Joanna' }, "Take care and goodbye!");
        errorResponse.hangup();
        res.type('text/xml').status(200).send(errorResponse.toString());
    }
};

export const handleSpeech = async (req, res) => {
    const twimlResponse = new twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const userInput = req.body.SpeechResult;
    const callId = req.query.callId;
    const publicUrl = (process.env.PUBLIC_URL || '').trim();

    try {
        console.log(`Controller: handleSpeech webhook hit. Call SID: ${callSid}, User input: "${userInput}", Call ID: ${callId}`);
        const history = await getOrCreateConversationHistory(callSid, callId);

        if (userInput && callId && isValidObjectId(callId)) {
            await ScheduledCall.findByIdAndUpdate(callId, {
                $push: { transcript: { role: 'user', message: userInput } }
            }).catch(e => console.error('DB update error in handleSpeech:', e.message));
            console.log(`Controller: Database mein user ka message store hua.`);
        }

        if (userInput && userInput.trim().length > 0) {
            const chat = geminiVoiceModel.startChat({ history });

            console.log("Controller: Gemini se user input ke liye jawab generate kar rahe hain...");
            const aiResponse = await getFastGeminiReply(
                chat,
                userInput,
                "I understand. Please take good rest and check in with your doctor if anything feels uncomfortable. Is there anything else on your mind?"
            );
            console.log(`Controller: Gemini ka jawab: "${aiResponse}"`);

            try {
                const updatedHistory = await chat.getHistory();
                if (callSid) conversationHistories.set(callSid, updatedHistory);
            } catch (hErr) {
                console.warn('Could not update history from chat session:', hErr.message);
            }

            if (callId && isValidObjectId(callId)) {
                await ScheduledCall.findByIdAndUpdate(callId, {
                    $push: { transcript: { role: 'assistant', message: aiResponse } }
                }).catch(e => console.error('DB update error in handleSpeech:', e.message));
                console.log(`Controller: Database mein AI ka jawab store hua.`);
            }

            const gather = twimlResponse.gather({
                input: 'speech',
                timeout: 5,
                speechTimeout: 'auto',
                action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
                method: 'POST',
            });

            gather.say({ voice: 'Polly.Joanna' }, aiResponse);

            // If user stays silent after AI response
            twimlResponse.say({ voice: 'Polly.Joanna' }, "Are you still there? I'm listening.");
            twimlResponse.gather({
                input: 'speech',
                timeout: 5,
                speechTimeout: 'auto',
                action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
                method: 'POST',
            });
            twimlResponse.say({ voice: 'Polly.Joanna' }, "Take care and have a wonderful day. Goodbye!");
            twimlResponse.hangup();
        } else {
            console.log("Controller: User ne kuch nahi bola.");
            const gather = twimlResponse.gather({
                input: 'speech',
                timeout: 5,
                speechTimeout: 'auto',
                action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
                method: 'POST',
            });
            gather.say({ voice: 'Polly.Joanna' }, "I didn't quite catch that. Could you please say that again?");
            twimlResponse.say({ voice: 'Polly.Joanna' }, "Take care and goodbye!");
            twimlResponse.hangup();
        }

        res.type('text/xml').status(200).send(twimlResponse.toString());
    } catch (error) {
        console.error('Controller: handleSpeech webhook mein ERROR:', error);
        const errorResponse = new twiml.VoiceResponse();
        const gather = errorResponse.gather({
            input: 'speech',
            timeout: 5,
            speechTimeout: 'auto',
            action: `${publicUrl}/api/calls/handle-speech?callId=${callId}`,
            method: 'POST',
        });
        gather.say({ voice: 'Polly.Joanna' }, "I had a brief connection delay. Could you please repeat what you said?");
        errorResponse.say({ voice: 'Polly.Joanna' }, "Take care and goodbye!");
        errorResponse.hangup();
        res.type('text/xml').status(200).send(errorResponse.toString());
    }
};

export const handleCallStatus = async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const callDuration = req.body.CallDuration;

    try {
        console.log(`Controller: handleCallStatus webhook hit. Call SID: ${callSid}, Status: ${callStatus}`);
        const scheduledCall = await ScheduledCall.findOne({ callSid });

        if (!scheduledCall) {
            console.error(`Controller: Scheduled call with SID ${callSid} not found.`);
            return res.status(404).send();
        }

        const updates = {};
        let shouldReschedule = false;

        if (callStatus === 'completed' && parseInt(callDuration, 10) > 0) {
            console.log(`Controller: Call ID ${scheduledCall._id} was answered. Setting status to 'completed'.`);
            updates.status = 'completed';
            updates.endTime = new Date();
            updates.durationInSeconds = parseInt(callDuration, 10);
            updates.triesLeft = 0;

            // 🔹 Step 1: Fetch full transcript
            const fullCall = await ScheduledCall.findById(scheduledCall._id).select('transcript');
            if (fullCall && fullCall.transcript.length > 0) {
                try {
                    // 🔹 Step 2: Convert transcript to text
                    const transcriptText = fullCall.transcript
                        .map(msg => `${msg.role === 'user' ? 'User' : 'AI'}: ${msg.message}`)
                        .join("\n");

                    // 🔹 Step 3: Ask Gemini for summary
                    const result = await geminiSummarizerModel.generateContent(
                        `Here is the transcript of a call:\n\n${transcriptText}\n\nPlease summarize this call in 2-3 concise sentences.`
                    );
                    const summary = result.response.text();

                    // 🔹 Step 4: Save summary into DB
                    updates.aiSummary = summary;
                    console.log(`Controller: AI summary generated and saved for call ${scheduledCall._id}`);
                } catch (err) {
                    console.error(`Controller: Failed to generate AI summary for call ${scheduledCall._id}:`, err.message);
                }
            }
        }
        // Conditions for a failed/unanswered call (no-answer, failed, or completed with 0 duration)
        else if (callStatus === 'no-answer' || callStatus === 'failed' || (callStatus === 'completed' && parseInt(callDuration, 10) === 0)) {
            updates.triesLeft = scheduledCall.triesLeft - 1;
            console.log(`Controller: Call ID ${scheduledCall._id} failed/not answered. TriesLeft updated to ${updates.triesLeft}.`);

            if (updates.triesLeft <= 0) {
                console.log(`Controller: Call ID ${scheduledCall._id} failed. TriesLeft is 0, setting final status to 'failed'.`);
                updates.status = 'failed';
                updates.endTime = new Date();
            } else {
                // Set status to 'in-progress' for subsequent retries
                updates.status = 'in-progress';
                const nextAttemptTime = new Date();
                nextAttemptTime.setMinutes(nextAttemptTime.getMinutes() + 1);

                updates.scheduledAt = nextAttemptTime;
                updates.$push = { scheduledAtHistory: nextAttemptTime };
                shouldReschedule = true;
                console.log(`Controller: Call ID ${scheduledCall._id} rescheduled for new time: ${nextAttemptTime.toISOString()}`);
            }
        }
        // Handle other possible Twilio statuses if needed, otherwise no update
        else {
            console.log(`Controller: Call ID ${scheduledCall._id} received an unhandled status: ${callStatus}. No update will be made.`);
        }

        await ScheduledCall.updateOne({ _id: scheduledCall._id }, updates);
        console.log(`Controller: Database updated for Call ID ${scheduledCall._id}. New status: ${updates.status}.`);

        if (shouldReschedule) {
            const updatedCall = await ScheduledCall.findById(scheduledCall._id);
            if (updatedCall) {
                scheduleNewCall(updatedCall);
            }
        }

        res.status(200).send();
    } catch (err) {
        console.error('Controller: Error in handleCallStatus:', err.message);
        res.status(500).send();
    }
};

export const createScheduledCall = async (req, res) => {
    try {
        console.log("📞 createScheduledCall API hit.");

        const { scheduledTo, scheduledAt } = req.body;
        const scheduledBy = req.user._id;

        // Step 1: Validate input
        if (!scheduledTo || !scheduledAt) {
            console.error("❌ Missing required fields.");
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: scheduledTo or scheduledAt'
            });
        }
        if (!isValidObjectId(scheduledTo)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID format",
            });
        }
        if (!isValidISOStringDate(scheduledAt)) {
            console.error("❌ Invalid time format.");
            return res.status(400).json({
                success: false,
                message: 'Invalid time format. Expected HH:mm (24-hour) format'
            });
        }
        // Step 2: Fetch current user with family members
        const user = await User.findById(scheduledBy).select('name phoneNumber familyMembers');
        if (!user) {
            console.error("❌ User not found.");
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        //-------------------checks current user is admin, if yes admin call schedule not allowed ------------------------------------
        if (user.role === 'admin') {
            return res.status(400).json({
                success: false,
                message: 'call schedule is not allowed to admin'
            });
        }
        let receiver;

        // Step 3: If self-call → use user details
        if (scheduledBy.toString() === scheduledTo.toString()) {
            console.log("🔄 Self-call scheduling detected. Using user details as receiver.");
            receiver = { name: user.name, phoneNumber: user.phoneNumber };
        }
        // Step 4: Else → validate family member link & fetch
        else {
            const isLinked = user.familyMembers.some(fm => fm.member.toString() === scheduledTo);
            if (!isLinked) {
                console.error(`❌ Family member ${scheduledTo} is not linked to user ${scheduledBy}.`);
                return res.status(400).json({
                    success: false,
                    message: 'This family member is not linked to the user, cannot schedule call.'
                });
            }

            receiver = await FamilyMember.findById(scheduledTo).select('name phoneNumber');
            if (!receiver || !receiver.phoneNumber) {
                console.error("❌ Receiver user or phone number not found.");
                return res.status(404).json({
                    success: false,
                    message: 'Receiver user or phone number not found.'
                });
            }
            if (receiver.isUser) {
                console.error("❌ This member is registered, cannot schedule call");
                return res.status(409).json({
                    success: false,
                    message: 'This member is already a registered user. Cannot schedule a call.'
                });
            }
        }

        // Step 5: Create call entry
        const initialScheduledAt = new Date(scheduledAt);
        const newCall = await ScheduledCall.create({
            recipientName: receiver.name,
            scheduledBy,
            scheduledTo,
            recipientNumber: receiver.phoneNumber,
            scheduledAt: initialScheduledAt,
            triesLeft: 3,
            scheduledAtHistory: [initialScheduledAt],
        });

        console.log(`✅ Call scheduled successfully. Call ID: ${newCall._id}`);

        // Step 6: Schedule the call in background
        scheduleNewCall(newCall);

        // Step 7: Send response
        res.status(201).json({
            success: true,
            message: 'Call scheduled successfully',
            scheduledCall: newCall
        });

    } catch (err) {
        console.error('❌ Error scheduling call:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

export const getAllScheduledCalls = async (req, res) => {
    try {
        console.log("Controller: getAllScheduledCalls API hit.");

        const userId = req.user._id;
        console.log("Controller: Authenticated user ID is:", userId);

        if (!userId) {
            console.error("Controller: User ID is missing from request.");
            return res.status(401).json({
                success: false,
                message: "User not authenticated.",
            });
        }

        const startTime = Date.now();

        // Get pagination params (default page=1, limit=10)
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        // Fetch calls with pagination
        const calls = await ScheduledCall.find({ scheduledBy: userId })
            .sort({ scheduledAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Total count for pagination metadata
        const totalCalls = await ScheduledCall.countDocuments({ scheduledBy: userId });

        const totalPages = Math.ceil(totalCalls / limit);

        const execTime = Date.now() - startTime;
        console.log(
            `Controller: Found ${calls.length} scheduled calls. Execution time: ${execTime}ms`
        );

        res.status(200).json({
            success: true,
            count: calls.length,
            page,
            limit,
            totalCalls,
            totalPages,
            hasNext: page < totalPages, // 👈 yeh batayega ki agla page available hai ya nahi
            data: calls,
        });
    } catch (err) {
        console.error("Controller: Error fetching scheduled calls:", err.message);
        res.status(500).json({
            success: false,
            message: "Server error fetching scheduled calls.",
        });
    }
};

export const deleteScheduledCall = async (req, res) => {
    try {
        const { id } = req.params; // call id
        const userId = req.user._id; // logged in user id (from auth middleware)

        console.log(`Controller: Attempting to delete scheduled call with ID: ${id} by User: ${userId}`);

        if (!id) {
            return res.status(400).json({
                status: 'fail',
                message: 'Call ID and Family Member ID (fmid) are required for deletion.'
            });
        }
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID format",
            });
        }
        // find call doc
        const callDoc = await ScheduledCall.findById(id);

        if (!callDoc) {
            console.log(`Controller: Scheduled call with ID ${id} not found.`);
            return res.status(404).json({
                status: 'fail',
                message: 'Scheduled call not found.'
            });
        }

        // check if scheduledBy matches current user
        if (callDoc.scheduledBy.toString() !== userId.toString()) {
            return res.status(403).json({
                status: 'fail',
                message: 'Not authorized to delete this call (user mismatch).'
            });
        }

        // check if scheduledTo matches current user
        if (callDoc.scheduledTo.toString() !== userId.toString()) {
            const FM = FamilyMember.findById(callDoc.scheduledTo)
            if (!FM || FM.isUser) {
                return res.status(403).json({
                    status: 'fail',
                    message: 'Not authorized to delete this call, reciepent is a registered user.'
                });
            }
        }

        //deleting active scheduled call from node cron server 
        const isDeletedCall = cancelScheduledCall(id)
        if (!isDeletedCall) {
            console.warn(`Controller: Could not cancel active node-cron job for Call ID ${id}. It might have already run or was not scheduled.`);
        }

        // delete if all checks pass
        const deletedCall = await callDoc.deleteOne();
        if (!deletedCall) {
            return res.status(404).json({
                success: false,
                message: "Scheduled Call not deleted",
            });
        }
        console.log(`Controller: Successfully deleted scheduled call with ID: ${id}.`);

        res.status(200).json({
            status: 'success',
            message: 'Scheduled call deleted successfully.',
            data: { deletedCall: callDoc },
        });

    } catch (error) {
        console.error('Controller: Error deleting scheduled call.', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Server error deleting scheduled call.'
        });
    }
};

export const updateScheduledCall = async (req, res) => {
    try {
        const { id } = req.params;
        const { scheduledAt } = req.body;
        console.log(`Controller: Attempting to update scheduled call with ID: ${id}`);

        if (!id || !scheduledAt) {
            return res.status(400).json({ message: 'ID and scheduledAt are required.' });
        }

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID format",
            });
        }

        if (!isValidISOStringDate(scheduledAt)) { // Make sure this function exists and is correct
            return res.status(400).json({
                success: false,
                message: 'Invalid time format. Expected ISO String format'
            });
        }

        const call = await ScheduledCall.findById(id);

        if (!call) {
            return res.status(404).json({ message: 'No scheduled call found.' });
        }

        const primaryUserId = req.user._id;

        if (primaryUserId.toString() !== call.scheduledBy.toString()) {
            return res.status(403).json({ message: 'You are not authorised to update this call.' });
        }

        // --- YEH HAI FIX ---
        // Ab hum sirf 'pending' status wali calls ko hi update karenge.
        if (call.status !== 'pending') {
            console.log(`Controller: Call status is not pending. Cannot update. Current status: ${call.status}`);
            return res.status(400).json({
                message: `Aap is call ko update nahi kar sakte kyunki yeh 'pending' status mein nahi hai. Iska current status hai: ${call.status}.`
            });
        }

        // Agar sab sahi hai, to scheduledAt ko update karo
        const newScheduledAt = new Date(scheduledAt);
        call.scheduledAt = newScheduledAt;
        call.scheduledAtHistory.push(newScheduledAt);

        await call.save();

        console.log(`Controller: Successfully updated scheduled call with ID: ${id}. New scheduled time: ${call.scheduledAt.toISOString()}`);

        // Naye time ke liye call ko reschedule karo
        scheduleNewCall(call);

        res.status(200).json({
            status: 'success',
            message: 'Scheduled call updated successfully.',
            data: { call },
        });

    } catch (error) {
        console.error('Controller: Error updating scheduled call.', error.message);
        res.status(500).json({ message: 'Server error updating scheduled call.' });
    }
};

export const getScheduledCalls = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            recipientName,
            scheduledToName,
            scheduledToId,
            recipientNumber,
            scheduledAtBeetweenStartDate,
            scheduledAtBeetweenEndDate,
            durationInSeconds,
            minDuration,
            maxDuration,
            startBetweenStartTime,
            startBetweenEndTime,
            endBetweenStartTime,
            endBetweenEndTime,
            status,
            triesLeft,
        } = req.query;

        const query = {};

        // ✅ Always filter by scheduledById from token (req.user._id)
        query.scheduledBy = req.user._id;

        // 🔍 recipientName
        if (recipientName) {
            query.recipientName = { $regex: recipientName, $options: "i" };
        }

        // if (!isValidISOStringDate()) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Invalid ID format",
        //     });
        // }
        // if (!isValidObjectId(scheduledToId)) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Invalid ID format",
        //     });
        // }
        // 🔍 scheduledToId (direct filter)
        if (scheduledToId) {
            query.scheduledTo = scheduledToId;
        }

        // 🔍 scheduledToName 
        if (scheduledToName) {
            const fms = await FamilyMember.find({
                name: { $regex: scheduledToName, $options: "i" },
                linkedToPrimaryUsers: req.user._id,   // ✅ filter by linked user also
            }).select("_id");

            const ids = fms.map((f) => f._id);

            query.scheduledTo = { $in: ids.length > 0 ? ids : [] };
        }

        // 🔍 recipientNumber
        if (recipientNumber) {
            query.recipientNumber = { $regex: recipientNumber, $options: "i" };
        }
        // 🔍 ScheduledAt
        if (req.query.scheduledAt) {
            const inputDate = new Date(req.query.scheduledAt);

            if (isNaN(inputDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid scheduledAt format",
                });
            }

            // दिन की शुरुआत और अंत निकालना (IST या जो भी timezone में आपने date भेजा है)
            const startOfDay = new Date(inputDate.setHours(0, 0, 0, 0));
            const endOfDay = new Date(inputDate.setHours(23, 59, 59, 999));

            query.scheduledAt = { $gte: startOfDay, $lte: endOfDay };
        }
        // 🔍 scheduledAt range
        if (scheduledAtBeetweenStartDate || scheduledAtBeetweenEndDate) {
            query.scheduledAt = {};
            if (scheduledAtBeetweenStartDate)
                query.scheduledAt.$gte = new Date(scheduledAtBeetweenStartDate);
            if (scheduledAtBeetweenEndDate)
                query.scheduledAt.$lte = new Date(scheduledAtBeetweenEndDate);
        }

        // 🔍 durationInSeconds
        if (durationInSeconds) {
            query.durationInSeconds = Number(durationInSeconds);
        }

        // 🔍 minDuration / maxDuration
        if (minDuration || maxDuration) {
            query.durationInSeconds = {};
            if (minDuration) query.durationInSeconds.$gte = Number(minDuration);
            if (maxDuration) query.durationInSeconds.$lte = Number(maxDuration);
        }

        // 🔍 startTime range
        if (startBetweenStartTime || startBetweenEndTime) {
            query.startTime = {};
            if (startBetweenStartTime) query.startTime.$gte = new Date(startBetweenStartTime);
            if (startBetweenEndTime) query.startTime.$lte = new Date(startBetweenEndTime);
        }

        // 🔍 endTime range
        if (endBetweenStartTime || endBetweenEndTime) {
            query.endTime = {};
            if (endBetweenStartTime) query.endTime.$gte = new Date(endBetweenStartTime);
            if (endBetweenEndTime) query.endTime.$lte = new Date(endBetweenEndTime);
        }

        // 🔍 status
        if (status) {
            query.status = status;
        }

        // 🔍 triesLeft
        if (triesLeft !== undefined) {
            query.triesLeft = Number(triesLeft);
        }

        // Pagination + Populate
        const calls = await ScheduledCall.find(query)
            .populate("scheduledBy", "name email phoneNumber")
            .populate("scheduledTo", "name email phoneNumber")
            .skip((page - 1) * limit)
            .limit(Number(limit))
            .sort({ createdAt: -1 });

        const total = await ScheduledCall.countDocuments(query);

        res.json({
            success: true,
            data: calls,
            total,
            page: Number(page),
            limit: Number(limit),
        });
    } catch (error) {
        console.error("Error fetching scheduled calls:", error);
        res
            .status(500)
            .json({ success: false, message: "Server Error", error: error.message });
    }
};
