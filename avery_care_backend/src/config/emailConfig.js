import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER || "akshatshri03@gmail.com",
        pass: process.env.EMAIL_PASS,
    },
});

export const sendEmail = async (userEmail, subject, text, html) => {
    try {
        const sender = process.env.EMAIL_USER || "akshatshri03@gmail.com";
        const info = await transporter.sendMail({
            from: `"Avery Care" <${sender}>`,
            to: userEmail,
            subject: subject,
            text: text,
            html: html,
        });
        console.log("Email sent: %s", info.messageId);
    } catch (err) {
        console.error('Email sending failed:', err.message);
        throw err; 
    }
};


