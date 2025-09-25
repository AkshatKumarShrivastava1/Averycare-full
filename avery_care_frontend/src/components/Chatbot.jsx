// Chatbot.jsx
import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Send Icon SVG
const SendIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z" fill="white"/>
  </svg>
);

// Robot Icon SVG
const RobotIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C9.79 2 8 3.79 8 6V7H6C5.45 7 5 7.45 5 8V14C5 14.55 5.45 15 6 15H8V16H16V15H18C18.55 15 19 14.55 19 14V8C19 7.45 18.55 7 18 7H16V6C16 3.79 14.21 2 12 2ZM12 4C13.1 4 14 4.9 14 6V7H10V6C10 4.9 10.9 4 12 4ZM7 9H9V11H7V9ZM15 9H17V11H15V9ZM8 17V19H16V17H8Z"/>
  </svg>
);

const Chatbot = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    { sender: 'bot', text: 'Hello! I am your health assistant. How can I help you today?' }
  ]);
  const [apiHistory, setApiHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const [sessionId, setSessionId] = useState(uuidv4());
  
  // Get user token from local storage
  const userToken = localStorage.getItem('token'); 

  // Function to scroll to the latest message
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || !userToken) {
      if (!userToken) {
        alert("Please login to use the chatbot.");
      }
      return;
    }

    const userMessage = { sender: 'user', text: input };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    setInput('');

    try {
      const response = await axios.post('https://averycare-full-production.up.railway.app/api/gemini/chat', {
        message: input,
        history: apiHistory,
        sessionId: sessionId,
      }, {
        headers: {
          'Authorization': `Bearer ${userToken}`
        }
      });

      const botMessage = { sender: 'bot', text: response.data.reply };
      setMessages((prev) => [...prev, botMessage]);
      setApiHistory(response.data.history);
    } catch (error) {
      console.error('Error communicating with API:', error.response?.data || error);
      const errorMessage = { sender: 'bot', text: 'Sorry, I am having trouble connecting or processing your request. Please try again later.' };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Chat Window */}
      <div className={`fixed bottom-24 right-5 z-50 w-[90vw] max-w-sm h-[70vh] bg-white rounded-lg shadow-xl flex flex-col transition-transform duration-300 ease-in-out ${isOpen ? 'transform scale-100' : 'transform scale-0'} origin-bottom-right`}>
        {/* Header */}
        <div className="p-4 bg-[#3FBF81] text-white rounded-t-lg flex justify-between items-center">
          <h3 className="text-lg font-semibold">Health AI Assistant</h3>
        </div>

        {/* Messages */}
        <div className="flex-1 p-4 space-y-4 overflow-y-auto bg-gray-50">
          {messages.map((msg, index) => (
            <div key={index} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`p-3 rounded-lg max-w-xs ${msg.sender === 'user' ? 'bg-[#3FBF81] text-white' : 'bg-gray-200 text-gray-800'}`}>
                {msg.text}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-200 text-gray-800 p-3 rounded-lg">
                <span className="animate-pulse">Thinking about health...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Form */}
        <form className="p-3 border-t border-gray-200 flex items-center bg-white" onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a health-related question..."
            className="flex-1 px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-[#3fBF81] focus:border-transparent"
          />
          <button type="submit" className="ml-3 w-10 h-10 flex items-center justify-center bg-[#3fBF81] text-white p-2 rounded-full focus:outline-none transition-colors" aria-label="Send message">
            <SendIcon />
          </button>
        </form>
      </div>

      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-5 right-5 z-50 h-16 w-16 bg-[#3FBF81] rounded-full flex items-center justify-center text-white text-3xl shadow-lg cursor-pointer transition-transform hover:scale-110"
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        {isOpen ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        ) : (
          <RobotIcon />
        )}
      </button>
    </>
  );
};


export default Chatbot;

