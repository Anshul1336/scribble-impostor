# Scribble: Impostor

Real-time multiplayer drawing-and-guessing game for 3-8 players — with a hidden Impostor twist.

**Play now:** (add live link here after deploying)

Built with the help of AI (Claude Code / Claude Opus) — game design, backend, frontend, and deployment.

## How to play

- One player creates a room and shares the 4-letter code. Everyone else joins from their own device.
- Each round, one player is the **Artist** and gets a secret word to draw on a shared canvas in real time.
- Everyone else guesses in the chat box. Faster correct guesses score more points; the Artist also earns points per correct guesser.
- **The twist:** one of the guessers is secretly the **Impostor** and is shown the word too. They have to fake it — post believable wrong guesses, then sneak in the correct answer without being obvious.
- After each round, everyone (except the Artist, who doesn't know who the Impostor is either) votes on who they think was faking it. If the majority correctly names the Impostor, the Impostor forfeits their points for that round. If they evade the vote, they keep everything.
- Play continues for a set number of rounds (host picks 3-20), then final scores decide the winner.

## Tech

Node.js, Express, Socket.io for real-time sync (canvas strokes + guesses + votes), vanilla HTML5 Canvas on the frontend. No database — game state lives in memory per room. Deployed on Render's free tier.

## Running locally

```
npm install
npm start
```

Then open `http://localhost:3001`.
