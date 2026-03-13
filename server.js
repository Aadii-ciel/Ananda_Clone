require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Memory storage for Vercel Serverless
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve Static Frontend Pages
const path = require('path');
app.use(express.static(__dirname));

// Serve Index by Default
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------------------------------------------
// AI / LLM CONFIGURATION (Powered by Gemini)
// ----------------------------------------------------
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Access your API key safely from the .env file
const genAI = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_API_KEY_HERE'
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

async function generateAIQuest(ikigaiText) {
    if (!genAI) {
        console.warn("No valid GEMINI_API_KEY found in .env. Falling back to default challenge.");
        return "Find 5 minutes of stillness today to reflect on your true direction. Breathe.";
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        let contextText = ikigaiText && ikigaiText.trim() !== "" ? ikigaiText : "Finding overall peace and focus in daily life.";

        const prompt = `You are a Zen master and productivity guide for the 'Ananda' app.
The user's Ikigai or current reality/challenge is: "${contextText}". 
Generate a short, actionable daily quest (maximum 2 sentences) that helps them take a micro-step towards their purpose or overcome their blocker today. 
The quest must include a specific, small physical or mindfulness action (e.g., 5 minutes of writing, taking a walk, doing 3 minutes of Box Breathing).
Keep the tone calm, encouraging, and slightly gamified. Do not use hashtags or emojis. Format as plain text.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (e) {
        console.error("Gemini API Error:", e);
        return "Find 5 minutes of stillness today to reflect on your true direction. Breathe.";
    }
}

// ----------------------------------------------------
// ROUTES
// ----------------------------------------------------

// 1. Authenticate / Get or Create User
app.post('/api/login', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ error: "Username is required" });
    }

    try {
        let { data: users, error: selectError } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .limit(1);

        if (selectError) throw selectError;

        if (users && users.length > 0) {
            // Returning user
            res.json({ message: "Welcome back", user: users[0] });
        } else {
            // New user
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([{ username, streak_count: 1 }])
                .select()
                .single();

            if (insertError) throw insertError;

            res.status(201).json({
                message: "User created",
                user: newUser
            });
        }
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Log SCV Configuration
app.post('/api/scv', async (req, res) => {
    const { user_id, internal_reality, external_contribution, ikigai_score, ikigai_text } = req.body;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    try {
        const { data, error } = await supabase
            .from('scv_logs')
            .insert([{ user_id, internal_reality, external_contribution, ikigai_score, ikigai_text }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json({ message: "SCV logged successfully", log_id: data.id });
    } catch (err) {
        console.error("SCV Log Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Generate Daily Quest (Using LLM Simulation for now)
app.post('/api/quests/generate', async (req, res) => {
    const { user_id, ikigai_text } = req.body;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    try {
        const questText = await generateAIQuest(ikigai_text);

        const { data, error } = await supabase
            .from('quests')
            .insert([{ user_id, quest_text, is_completed: false }])
            .select()
            .single();

        if (error) throw error;

        res.status(201).json({
            quest_id: data.id,
            quest_text: questText
        });
    } catch (error) {
        console.error("Quest Generation Error:", error);
        res.status(500).json({ error: "Failed to generate quest" });
    }
});

// 4. Complete Quest & Increment Streak
app.post('/api/quests/complete', async (req, res) => {
    const { user_id, quest_id, reflection_text } = req.body;

    if (!user_id || !quest_id) return res.status(400).json({ error: "user_id and quest_id are required" });

    try {
        // AI Evaluation of Reflection
        let aiAnalysis = { cr_delta: 0, er_delta: 0, ikigai_delta: 0, feedback: "Reflection recorded." };

        if (reflection_text && genAI) {
            try {
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                const prompt = `You are a Zen growth analyzer. 
The user completed a quest and provided this reflection: "${reflection_text}".
Analyze this reflection and determine how it affects their Serenity-Clarity Value (SCV) components.
Return ONLY a valid JSON object with the following exact keys:
"cr_delta": integer between -1 and +2 (Internal Reality impact),
"er_delta": integer between -1 and +2 (External Contribution impact),
"ikigai_delta": integer between -1 and +1 (Ikigai Score impact),
"feedback": A short, 1-sentence encouraging Zen response to their reflection.`;

                const result = await model.generateContent(prompt);
                let text = result.response.text();
                // strip markdown if needed
                text = text.replace(/```json/g, "").replace(/```/g, "").trim();
                aiAnalysis = JSON.parse(text);
            } catch (e) {
                console.error("AI Evaluation error:", e);
                aiAnalysis.feedback = "Your reflection has been embraced by the void.";
            }
        }

        // Mark quest complete
        const { error: questError } = await supabase
            .from('quests')
            .update({
                is_completed: true,
                completed_at: new Date().toISOString(),
                reflection: reflection_text || null
            })
            .eq('id', quest_id)
            .eq('user_id', user_id);

        if (questError) throw questError;

        // Fetch current streak
        const { data: userRow, error: fetchUserError } = await supabase
            .from('users')
            .select('streak_count')
            .eq('id', user_id)
            .single();

        if (fetchUserError) throw fetchUserError;

        const newStreak = (userRow.streak_count || 0) + 1;

        // Increment user streak
        const { error: userUpdateError } = await supabase
            .from('users')
            .update({ streak_count: newStreak })
            .eq('id', user_id);

        if (userUpdateError) throw userUpdateError;

        res.json({
            message: "Quest completed",
            new_streak: newStreak,
            ai_analysis: aiAnalysis
        });
    } catch (err) {
        console.error("Quest Completion Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Catch-all GET for testing server status
app.get('/api/status', (req, res) => {
    res.json({ status: "Ananda API is running smoothly." });
});

// 5. Chatbot Endpoint (Zen Guide)
app.post('/api/chat', async (req, res) => {
    const { message, ikigai_text } = req.body;

    if (!message) return res.status(400).json({ error: "Message is required" });

    if (!genAI) {
        return res.json({ reply: "I am processing this entirely locally right now. Zen mode engaged." });
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        let contextText = ikigai_text && ikigai_text.trim() !== "" ? ikigai_text : "Finding peace and focus.";

        const prompt = `You are a Zen master and productivity guide for the 'Ananda' app.
The user's Ikigai or current reality is: "${contextText}". 
The user says: "${message}"

Respond to the user with empathy, clarity, and actionable Zen wisdom. 
Keep your response under 3 sentences. Do not use markdown like bolding or bullet points. Speak simply and directly.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        res.json({ reply: response.text() });
    } catch (e) {
        console.error("Gemini API Error:", e);
        res.status(500).json({ error: "Failed to communicate with Zen Guide." });
    }
});

// ----------------------------------------------------
// MEDIA UPLOAD & GALLERY ROUTES
// ----------------------------------------------------

// Ensure bucket exists helper
let bucketCreated = false;
async function ensureBucket() {
    if (bucketCreated) return;
    try {
        await supabase.storage.createBucket('ananda_media', { public: true });
        bucketCreated = true;
    } catch (err) {
        // Bucket probably exists
        bucketCreated = true;
    }
}

// 6. Upload Media
app.post('/api/media/upload', upload.single('mediaFile'), async (req, res) => {
    const { user_id, title, media_type } = req.body;
    const file = req.file;

    if (!user_id || !file) {
        return res.status(400).json({ error: "user_id and mediaFile are required" });
    }

    try {
        await ensureBucket();

        // Upload to Supabase Storage
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `${user_id}/${fileName}`;

        const { data: storageData, error: storageError } = await supabase.storage
            .from('ananda_media')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (storageError) throw storageError;

        // Get public URL
        const { data: publicUrlData } = supabase.storage
            .from('ananda_media')
            .getPublicUrl(filePath);

        const mediaUrl = publicUrlData.publicUrl;

        // Save metadata to user_media table
        const { data: dbData, error: dbError } = await supabase
            .from('user_media')
            .insert([{
                user_id,
                media_url: mediaUrl,
                media_type: media_type || (file.mimetype.startsWith('audio/') ? 'audio' : 'image'),
                title: title || 'Captured Moment'
            }])
            .select()
            .single();

        if (dbError) throw dbError;

        res.status(201).json({ message: "Media uploaded successfully", media: dbData });
    } catch (err) {
        console.error("Media Upload Error:", err);
        res.status(500).json({ error: "Failed to upload media" });
    }
});

// 7. Get User Gallery
app.get('/api/media/:userId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('user_media')
            .select('*')
            .eq('user_id', req.params.userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ gallery: data });
    } catch (err) {
        console.error("Gallery Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch gallery" });
    }
});

// Start Server (Export for Vercel Serverless, Listen for Local)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🌿 Ananda Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
