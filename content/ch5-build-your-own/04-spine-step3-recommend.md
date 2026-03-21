---
id: ch5-recommend
type: spine
title: "Step 3: Make Your Predictions"
readingTime: 3
standalone: true
core: true
teaser: "Use your similar users to predict ratings and make real recommendations."
voice: universal
parent: null
diagram: null
---

You've got your rating matrix. You know who's similar to who. Now for the big moment: **predicting ratings and making recommendations.**

**The Method:**

For every empty cell in your matrix (a movie someone hasn't seen), do this:

1. Find the 2-3 most similar people who DID rate that movie
2. Look at their ratings
3. Calculate the average
4. That average is your **predicted rating**

**Example:**

Sam hasn't seen The Super Mario Bros. Movie. Who are Sam's most similar users?

From Step 2, we know:
- Alex is very similar to Sam (similarity score: high)
- Maya is somewhat similar to Sam (similarity score: medium)

Alex rated Mario: **3 stars**
Maya rated Mario: **4 stars**

Predicted rating for Sam = (3 + 4) / 2 = **3.5 stars**

Not bad! That's a "they'll probably think it's okay but not amazing" prediction.

**Making the Recommendation:**

Now do this for EVERY movie Sam hasn't seen. You might get:

| Movie Sam hasn't seen | Predicted rating |
|---|---|
| The Super Mario Bros. Movie | 3.5 |
| Inside Out 2 | 4.5 |
| Dune | 2.0 |
| Kung Fu Panda 4 | 4.0 |

**Your recommendation rule:** Anything predicted at **4 stars or above** gets recommended!

So you'd recommend to Sam:
1. Inside Out 2 (predicted: 4.5)
2. Kung Fu Panda 4 (predicted: 4.0)

And you'd skip Dune (predicted: 2.0) and Mario (predicted: 3.5).

**Now test it!**

This is the most important part. Go back to Sam (or whoever you made predictions for) and ask: "Have you seen Inside Out 2? What did you think?"

If Sam says "I loved it!" -- your system worked!
If Sam says "Meh, it was boring" -- your system needs improvement.

**Keep score:**

| Person | Movie predicted | Predicted rating | Actual rating | Close? |
|---|---|---|---|---|
| Sam | Inside Out 2 | 4.5 | ? | |
| Sam | Kung Fu Panda 4 | 4.0 | ? | |

If your predicted ratings are within 1 star of the actual ratings most of the time, you've built a genuinely useful recommendation system. Congratulations -- you're officially a recommendation engineer!

**Think about it!** How accurate were your predictions? If some were way off, what do you think went wrong? Maybe you needed more data, or maybe those people are just unpredictable. That's totally normal -- even Netflix can't get it right every time.
