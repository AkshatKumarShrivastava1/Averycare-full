import { twiml } from 'twilio';
import { GoogleGenerativeAI } from '@google/generative-ai';
import twilioClient from '../config/twilio.js';
// --- Initialization ---
if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in the .env file.');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    generationConfig: {
        maxOutputTokens: 70,
        temperature: 0.7,
    },
    systemInstruction: "You are a friendly and caring health assistant AI of Avery Care on a live phone call. Check in warmly on the user's health and well-being. Never provide medical advice. Keep your response strictly under 2 short conversational sentences (maximum 30 words) so it is clear and quick to speak over the phone."
});
const conversationHistories = new Map();

function getOrCreateConversationHistory(callSid) {
    if (!conversationHistories.has(callSid)) {
        conversationHistories.set(callSid, []);
    }
    return conversationHistories.get(callSid);
}
// --- Service Functions ---
const initiateCall = async (to) => {
    const voiceUrl = `${process.env.PUBLIC_URL}/api/calls/voice`;
    console.log(`Making call to: ${to}`);
    console.log(`Using webhook URL: ${voiceUrl}`);
    const call = await twilioClient.calls.create({
        url: voiceUrl,
        to: to,
        from: process.env.TWILIO_PHONE_NUMBER,
    });
    console.log(`Call initiated with SID: ${call.sid}`);
    return call.sid;
};
const startConversation = async (callSid) => {
    console.log(`Call answered. SID: ${callSid}`);
    const twimlResponse = new twiml.VoiceResponse();
    const history = getOrCreateConversationHistory(callSid);
    const chat = geminiModel.startChat({
        history,
    });
    const result = await chat.sendMessage("Start the conversation by introducing yourself and asking me how I'm doing.");
    const aiResponse = result.response.text();
    console.log(`Initial AI Greeting: "${aiResponse}"`);
    history.push({ role: 'model', parts: [{ text: aiResponse }] });
    const gather = twimlResponse.gather({
        input: 'speech',
        speechTimeout: 'auto',
        action: '/api/calls/handle-speech',
        method: 'POST',
    });
    gather.say({ voice: 'Polly.Joanna' }, aiResponse);
    // twimlResponse.redirect({ method: 'POST' }, '/api/calls/voice');
    return twimlResponse;
};
const continueConversation = async (callSid, userInput) => {
    console.log(`Received user speech: "${userInput}"`);
    const twimlResponse = new twiml.VoiceResponse();
    const history = getOrCreateConversationHistory(callSid);
    if (userInput) {
        history.push({ role: 'user', parts: [{ text: userInput }] });
        const chat = geminiModel.startChat({
            history,
        });
        const result = await chat.sendMessage(userInput);
        const aiResponse = result.response.text();
        console.log(`AI Response: "${aiResponse}"`);
        history.push({ role: 'model', parts: [{ text: aiResponse }] });
        const gather = twimlResponse.gather({
            input: 'speech',
            speechTimeout: 'auto',
            action: '/api/calls/handle-speech',
            method: 'POST',
        });
        gather.say({ voice: 'Polly.Joanna' }, aiResponse);
    } else {
        twimlResponse.say({ voice: 'Polly.Joanna' }, "I didn't catch that. Could you please say it again?");
        twimlResponse.gather({
            input: 'speech',
            speechTimeout: 'auto',
            action: '/api/calls/handle-speech',
            method: 'POST',
        });
    }
    return twimlResponse;
};
export {
    initiateCall,
    startConversation,
    continueConversation
};
