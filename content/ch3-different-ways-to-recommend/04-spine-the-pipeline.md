---
id: ch3-pipeline
type: spine
title: "The Recommendation Pipeline"
readingTime: 3
standalone: true
core: true
teaser: "Real systems don't use just one method. They use ALL of them, in three clever steps."
voice: universal
parent: null
diagram: kids-pipeline
---

Here's something important: real recommendation systems don't pick just one method. They don't say "we're a collaborative filtering company" or "we only do content-based."

They use **everything**. All the methods. Together. In a specific order.

This is called the **recommendation pipeline**, and every major platform uses one. Think of it like a chef preparing a meal in three steps.

## Step 1: FIND (Gather the Ingredients)

First, the system casts a wide net. Out of millions of possible items, it quickly grabs a few hundred that MIGHT be relevant to you.

It uses fast, simple methods:
- Collaborative filtering: "Users like you watched these"
- Content-based: "These are similar to what you just watched"
- Popularity: "These are trending right now"
- Social: "Your friends liked these"

The goal isn't perfection. It's speed. The system needs to narrow millions of items down to maybe 500 candidates in milliseconds.

This is like the chef gathering ingredients from the pantry. Grab everything that could work. Don't worry about the recipe yet.

## Step 2: RANK (Cook the Meal)

Now the system takes those 500 candidates and carefully scores each one. This is where the heavy-duty math happens.

For each candidate, it asks:
- How likely are you to click on this? (60%? 20%? 2%?)
- How likely are you to watch the whole thing?
- How likely are you to like it or share it?
- How well does it match your recent mood?

Each item gets a score. The system ranks them from highest to lowest.

This is the actual cooking. The chef takes the ingredients and turns them into something delicious, carefully adjusting the recipe.

## Step 3: CHECK (Plate It Nicely)

The top-ranked items aren't just dumped on your screen. The system does final checks:

- **Variety**: Don't show 10 Minecraft videos in a row. Mix it up! Maybe 3 Minecraft, 2 music, 2 science, 2 comedy, 1 surprise.
- **Freshness**: Include some new content, not just old favorites.
- **Appropriateness**: Make sure everything is suitable for your age and follows platform rules.
- **No repeats**: Don't show something you already watched.

This is the plating -- making sure the final meal looks good and has a nice balance of flavors.

## The Result

After all three steps, you see about 10-20 items on your screen. Each one survived a brutal competition:

- Started as one of millions of possibilities
- Made it into the top 500 candidates
- Got ranked and scored
- Passed the final quality checks

All of this happens in **less than one second**. Every single time you open the app.

**Think about it!** Next time you refresh your YouTube homepage, remember: in the time it took the page to load, the system evaluated thousands of videos, scored them all, checked for variety, and picked the best ones just for you. Under one second. That's incredible engineering.
