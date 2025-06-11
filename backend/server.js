// server.js - Main backend server file
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dailycode', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Schemas
const DailyPuzzleSchema = new mongoose.Schema({
    date: { type: String, unique: true, required: true },
    solution: [Number],
    totalPlayers: { type: Number, default: 0 },
    completedPlayers: { type: Number, default: 0 },
    fastestTime: { type: Number, default: null },
    fastestPlayer: { type: String, default: null },
    averageGuesses: { type: Number, default: 0 },
    totalGuesses: { type: Number, default: 0 }
});

const PlayerSchema = new mongoose.Schema({
    playerId: { type: String, unique: true, required: true },
    email: { type: String, unique: true, sparse: true },
    username: { type: String, unique: true, sparse: true },
    passwordHash: String,
    stats: {
        gamesPlayed: { type: Number, default: 0 },
        gamesWon: { type: Number, default: 0 },
        currentStreak: { type: Number, default: 0 },
        maxStreak: { type: Number, default: 0 },
        totalGuesses: { type: Number, default: 0 },
        lastPlayDate: String,
        fastestTime: Number
    },
    games: [{
        date: String,
        won: Boolean,
        guesses: Number,
        time: Number,
        attempts: [[Number]] // Array of attempts
    }],
    createdAt: { type: Date, default: Date.now }
});

const LeaderboardSchema = new mongoose.Schema({
    date: { type: String, required: true },
    type: { type: String, enum: ['daily', 'weekly', 'alltime'], required: true },
    entries: [{
        playerId: String,
        username: String,
        score: Number,
        time: Number,
        guesses: Number
    }]
});

// Models
const DailyPuzzle = mongoose.model('DailyPuzzle', DailyPuzzleSchema);
const Player = mongoose.model('Player', PlayerSchema);
const Leaderboard = mongoose.model('Leaderboard', LeaderboardSchema);

// Helper Functions
function generateDailyCode(dateString, allowDuplicates = false) {
    const seed = hashCode(dateString);
    const rng = seededRandom(seed);
    
    const numbers = [1, 2, 3, 4, 5, 6];
    const code = [];
    
    for (let i = 0; i < 4; i++) {
        const availableNumbers = allowDuplicates ? 
            numbers : 
            numbers.filter(n => !code.includes(n));
        
        const randomIndex = Math.floor(rng() * availableNumbers.length);
        code.push(availableNumbers[randomIndex]);
    }
    
    return code;
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

function seededRandom(seed) {
    let state = seed;
    return function() {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

// API Routes

// Get or create daily puzzle
app.get('/api/puzzle/today', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        let puzzle = await DailyPuzzle.findOne({ date: today });
        
        if (!puzzle) {
            // Generate new puzzle for today
            const solution = generateDailyCode(today, req.query.duplicates === 'true');
            puzzle = new DailyPuzzle({
                date: today,
                solution: solution
            });
            await puzzle.save();
        }
        
        // Don't send solution to client
        res.json({
            date: puzzle.date,
            totalPlayers: puzzle.totalPlayers,
            completedPlayers: puzzle.completedPlayers,
            fastestTime: puzzle.fastestTime,
            averageGuesses: puzzle.averageGuesses
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get yesterday's solution
app.get('/api/puzzle/yesterday', async (req, res) => {
    try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateString = yesterday.toISOString().split('T')[0];
        
        const puzzle = await DailyPuzzle.findOne({ date: dateString });
        
        if (puzzle) {
            res.json({
                date: puzzle.date,
                solution: puzzle.solution,
                totalPlayers: puzzle.totalPlayers,
                completedPlayers: puzzle.completedPlayers,
                fastestTime: puzzle.fastestTime,
                averageGuesses: puzzle.averageGuesses
            });
        } else {
            res.status(404).json({ error: 'Yesterday\'s puzzle not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Submit game result
app.post('/api/game/submit', async (req, res) => {
    try {
        const { playerId, date, won, guesses, time, attempts } = req.body;
        
        // Get or create player
        let player = await Player.findOne({ playerId });
        if (!player) {
            player = new Player({ playerId });
        }
        
        // Check if already played today
        const existingGame = player.games.find(g => g.date === date);
        if (existingGame) {
            return res.status(400).json({ error: 'Already played today' });
        }
        
        // Update player stats
        player.stats.gamesPlayed++;
        if (won) {
            player.stats.gamesWon++;
            player.stats.totalGuesses += guesses;
            
            // Update streaks
            const yesterday = new Date(date);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayString = yesterday.toISOString().split('T')[0];
            
            if (player.stats.lastPlayDate === yesterdayString) {
                player.stats.currentStreak++;
            } else {
                player.stats.currentStreak = 1;
            }
            
            player.stats.maxStreak = Math.max(player.stats.maxStreak, player.stats.currentStreak);
            
            if (!player.stats.fastestTime || time < player.stats.fastestTime) {
                player.stats.fastestTime = time;
            }
        } else {
            player.stats.currentStreak = 0;
        }
        
        player.stats.lastPlayDate = date;
        
        // Add game to history
        player.games.push({
            date,
            won,
            guesses,
            time,
            attempts
        });
        
        await player.save();
        
        // Update daily puzzle stats
        const puzzle = await DailyPuzzle.findOne({ date });
        if (puzzle) {
            puzzle.totalPlayers++;
            if (won) {
                puzzle.completedPlayers++;
                puzzle.totalGuesses += guesses;
                puzzle.averageGuesses = puzzle.totalGuesses / puzzle.completedPlayers;
                
                if (!puzzle.fastestTime || time < puzzle.fastestTime) {
                    puzzle.fastestTime = time;
                    puzzle.fastestPlayer = player.username || playerId;
                }
            }
            await puzzle.save();
            
            // Update leaderboards
            await updateLeaderboards(date, player, won, guesses, time);
        }
        
        res.json({
            success: true,
            stats: player.stats,
            todayStats: {
                totalPlayers: puzzle.totalPlayers,
                completedPlayers: puzzle.completedPlayers,
                fastestTime: puzzle.fastestTime,
                averageGuesses: puzzle.averageGuesses
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get player stats
app.get('/api/player/:playerId/stats', async (req, res) => {
    try {
        const player = await Player.findOne({ playerId: req.params.playerId });
        
        if (!player) {
            return res.json({
                stats: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    currentStreak: 0,
                    maxStreak: 0,
                    totalGuesses: 0,
                    winRate: 0,
                    averageGuesses: 0
                }
            });
        }
        
        const stats = {
            ...player.stats,
            winRate: player.stats.gamesPlayed > 0 ? 
                Math.round((player.stats.gamesWon / player.stats.gamesPlayed) * 100) : 0,
            averageGuesses: player.stats.gamesWon > 0 ? 
                (player.stats.totalGuesses / player.stats.gamesWon).toFixed(1) : 0
        };
        
        res.json({ stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get leaderboards
app.get('/api/leaderboard/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { date } = req.query;
        
        let query = { type };
        if (type === 'daily' && date) {
            query.date = date;
        } else if (type === 'weekly') {
            // Get current week's Monday
            const today = new Date();
            const monday = new Date(today);
            monday.setDate(today.getDate() - today.getDay() + 1);
            query.date = monday.toISOString().split('T')[0];
        }
        
        const leaderboard = await Leaderboard.findOne(query)
            .sort({ 'entries.score': -1 })
            .limit(100);
        
        res.json(leaderboard || { entries: [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update leaderboards function
async function updateLeaderboards(date, player, won, guesses, time) {
    if (!won) return;
    
    // Daily leaderboard
    let dailyBoard = await Leaderboard.findOne({ date, type: 'daily' });
    if (!dailyBoard) {
        dailyBoard = new Leaderboard({ date, type: 'daily', entries: [] });
    }
    
    const score = 1000 - (guesses * 100) - (time / 10); // Score formula
    
    dailyBoard.entries.push({
        playerId: player.playerId,
        username: player.username || 'Anonymous',
        score,
        time,
        guesses
    });
    
    dailyBoard.entries.sort((a, b) => b.score - a.score);
    dailyBoard.entries = dailyBoard.entries.slice(0, 100); // Keep top 100
    
    await dailyBoard.save();
}

// Register/Login endpoints for authenticated features
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, playerId } = req.body;
        
        // Check if username/email already exists
        const existing = await Player.findOne({ 
            $or: [{ username }, { email }] 
        });
        
        if (existing) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        
        // Get or create player
        let player = await Player.findOne({ playerId });
        if (!player) {
            player = new Player({ playerId });
        }
        
        // Update with registration info
        player.username = username;
        player.email = email;
        player.passwordHash = await bcrypt.hash(password, 10);
        
        await player.save();
        
        const token = jwt.sign({ playerId: player.playerId }, process.env.JWT_SECRET);
        
        res.json({ token, username: player.username });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const player = await Player.findOne({ 
            $or: [{ username }, { email: username }] 
        });
        
        if (!player || !player.passwordHash) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const valid = await bcrypt.compare(password, player.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ playerId: player.playerId }, process.env.JWT_SECRET);
        
        res.json({ 
            token, 
            username: player.username,
            playerId: player.playerId 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Daily Code backend running on port ${PORT}`);
});

// Export for testing
module.exports = app;