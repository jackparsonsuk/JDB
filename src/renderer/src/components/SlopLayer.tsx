import { useEffect, useMemo, useState } from 'react'
import { useSlop } from '../lib/slop'

const EMOJI = ['✨', '🚀', '🤖', '💯', '🔥', '🧠', '⚡', '🌈', '💎', '🦄', '🎉', '📈', '🪄', '💫', '🌟']

const TAGLINES = [
  "✨ Unlocking the full potential of your data with cutting-edge AI ✨",
  "🚀 Seamlessly empowering synergistic insights at scale 🚀",
  "🧠 It's not just a database — it's a journey 🧠",
  "💎 Delve into a rich tapestry of rows 💎",
  "🌈 Revolutionising the SELECT statement for the modern era 🌈",
  "🔥 10x your queries with next-gen holistic paradigms 🔥",
  "🦄 Let's embark on this transformative data adventure together 🦄"
]

const BUBBLES = [
  'Great question! 🙌',
  "I'd be happy to help you delve into that table! ✨",
  'Certainly! Here is a comprehensive overview 📊',
  "That's a really insightful JOIN 🧠",
  'In the ever-evolving landscape of SQL… 🌍',
  'Let me know if you have any other questions! 😊',
  "It's important to note that NULL is also a vibe 💅",
  'As an AI-powered viewer, I love your schema 💖'
]

const FLOATERS = 24

/** The floating extras for slop mode: drifting emoji, a marquee and a helpful assistant. */
export function SlopLayer() {
  const slop = useSlop()
  const [bubble, setBubble] = useState(0)

  useEffect(() => {
    if (!slop) return
    const timer = window.setInterval(() => setBubble((b) => (b + 1) % BUBBLES.length), 3500)
    return () => window.clearInterval(timer)
  }, [slop])

  // Positions are picked once so the emoji don't jump about on every re-render.
  const floaters = useMemo(
    () =>
      Array.from({ length: FLOATERS }, (_, i) => ({
        emoji: EMOJI[i % EMOJI.length],
        left: Math.random() * 100,
        delay: Math.random() * -20,
        duration: 12 + Math.random() * 14,
        size: 16 + Math.random() * 26
      })),
    []
  )

  if (!slop) return null
  return (
    <div className="slop-layer" aria-hidden>
      {floaters.map((f, i) => (
        <span
          key={i}
          className="slop-floater"
          style={{ left: `${f.left}%`, animationDelay: `${f.delay}s`, animationDuration: `${f.duration}s`, fontSize: f.size }}
        >
          {f.emoji}
        </span>
      ))}
      <div className="slop-marquee">
        <div className="slop-marquee-track">{[...TAGLINES, ...TAGLINES].join('   •   ')}</div>
      </div>
      <div className="slop-assistant">
        <div className="slop-bubble" key={bubble}>{BUBBLES[bubble]}</div>
        <div className="slop-bot">🤖</div>
      </div>
    </div>
  )
}
