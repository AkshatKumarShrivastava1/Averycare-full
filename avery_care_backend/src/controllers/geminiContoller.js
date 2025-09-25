// controllers/geminiController.js
import axios from "axios";

// A temporary in-memory map to store chat history
const conversationHistories = new Map();

// System instruction as a plain string
const systemInstruction = "You are a friendly and helpful AI assistant specializing in health-related topics. You can provide information on general health, fitness, nutrition, common ailments, and wellness tips. If a user asks a question not related to health, politely inform them that you can only discuss health topics and ask them to rephrase their question or ask a health-related one. Do not answer questions outside of health. The current location is Indore, Madhya Pradesh, India.";

function getOrCreateConversationHistory(sessionId) {
  if (!conversationHistories.has(sessionId)) {
    conversationHistories.set(sessionId, []);
  }
  return conversationHistories.get(sessionId);
}

const generateChatReply = async (req, res) => {
  const { message, history, sessionId } = req.body;
  const API_KEY = process.env.GEMINI_API_KEY;
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;
  const userId = req.user?._id; 

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const chatHistory = getOrCreateConversationHistory(sessionId);

    // Check for keywords to call your APIs
    let apiResponseText = null;
    const sanitizedMessage = message.toLowerCase();

    if (sanitizedMessage.includes("family members") || sanitizedMessage.includes("my family")) {
      const familyMembers = await axios.get(`http://localhost:5000/api/family/fetchFamilyMembers`, {
        headers: { Authorization: req.headers.authorization }
      });
      if (familyMembers.data.data.length > 0) {
        const list = familyMembers.data.data.map(fm => `${fm.name} (${fm.relationship})`).join(', ');
        apiResponseText = `Aapke family members hain: ${list}.`;
      } else {
        apiResponseText = "Aapki family list mein koi member nahi hai.";
      }
    } else if (sanitizedMessage.includes("scheduled calls") || sanitizedMessage.includes("upcoming calls")) {
      const scheduledCalls = await axios.get(`http://localhost:5000/api/calls/getScheduledCalls`, {
        headers: { Authorization: req.headers.authorization }
      });
      if (scheduledCalls.data.data.length > 0) {
        const calls = scheduledCalls.data.data;
        let responseMessage = "Aapki agli calls ye hain: \n";
        calls.forEach(call => {
            const time = new Date(call.scheduledAt).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
            const statusText = call.status === 'pending' ? ' pending hai.' : ' ho chuki hai.';
            responseMessage += `• ${call.recipientName} ko call ${time} baje ${statusText} \n`;
        });
        apiResponseText = responseMessage;
      } else {
        apiResponseText = "Aapki koi scheduled calls nahi hain.";
      }
    }

    if (apiResponseText) {
      chatHistory.push({ role: 'user', parts: [{ text: message }] });
      chatHistory.push({ role: 'model', parts: [{ text: apiResponseText }] });
      return res.json({ reply: apiResponseText, history: chatHistory });
    }

    // Normal chat with Gemini
    const combinedMessage = history.length === 0 
      ? `${systemInstruction} ${message}`
      : message;

    const requestBody = {
      contents: [
        ...history,
        { role: 'user', parts: [{ text: combinedMessage }] },
      ],
    };

    const response = await axios.post(API_URL, requestBody);
    const botResponse = response.data.candidates[0].content.parts[0].text;
    chatHistory.push({ role: 'user', parts: [{ text: message }] });
    chatHistory.push({ role: 'model', parts: [{ text: botResponse }] });
    res.json({ reply: botResponse, history: chatHistory });

  } catch (error) {
    console.error('Error in geminiController:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to get response from AI' });
  }
};

export { generateChatReply };