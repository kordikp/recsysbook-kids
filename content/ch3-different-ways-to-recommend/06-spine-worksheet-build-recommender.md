---
id: ch3-ws-build
type: spine
title: "Build a Recommender in Your Head"
readingTime: 5
standalone: true
teaser: "You don't need a computer to do collaborative filtering — you just need a friend!"
voice: universal
parent: null
diagram: null
---

# Build a Recommender in Your Head

You don't need a computer to build a recommendation system. You don't even need an app. All you need is one friend (or sibling, or parent) and about five minutes. Ready? Let's do collaborative filtering — the human way.

---

## Step 1: Pick Your Top 3

Think of your 3 favorite movies or shows right now. Not all-time favorites — the ones you're into RIGHT NOW. Got them locked in your head? Good. Don't say them out loud yet.

---

## Step 2: Get Their Top 3

Now ask someone near you — a friend, a sibling, a parent, whoever's around — for THEIR current top 3 movies or shows. Let them answer first so you don't influence their picks.

---

## Step 3: Count the Overlap

Compare your lists. How many titles show up on BOTH lists?

- **2 or 3 matches:** You're taste twins! You like the same stuff. This is gold for recommendations.
- **1 match:** Some overlap. You're in the same neighborhood but not the same house.
- **Zero matches:** Totally different taste. That's fine — it just means recommendations between you two probably won't work well.

---

## Step 4: Get Your Recommendation

Here's where the magic happens.

**If you're taste twins** (1 or more matches): Ask them what they've been watching lately that ISN'T on their top 3 list — something they loved that you haven't seen yet. THAT is your recommendation. Because you agree on so many things, there's a solid chance you'll love their pick too.

**If you have zero overlap:** Their suggestion probably won't land for you. But try it anyway if you're feeling adventurous — sometimes the best discoveries come from unexpected places.

---

## Step 5: Test It

Watch their recommendation. Did they nail it? Did you love it, or was it a total miss?

If it worked, congratulations — collaborative filtering just proved itself. If it didn't, that's useful data too. Even Netflix gets it wrong sometimes.

---

## What Just Happened

You just did **collaborative filtering** with your bare brain. Find someone with similar taste. See what they liked that you haven't tried. Use their taste to predict yours.

Netflix does the exact same thing — but with **230 million people** instead of 2, and computers crunching the numbers instead of you asking "so what are you watching these days?"

The core idea is identical. Scale and speed are the only differences. Not bad for five minutes of thinking, right?

---

**type: question**

Your taste twin loves a movie you've never heard of. How confident are you that you'll like it too?

- Very confident — we agreed on almost everything!
- Somewhat confident — we had some overlap
- Not confident — we had zero matches, so who knows
- It depends on what kind of movie it is

Think about it: the MORE things you agree on, the stronger the prediction. That's why Netflix needs millions of ratings — more data means better matches.
