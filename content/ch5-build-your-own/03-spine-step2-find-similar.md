---
id: ch5-similar
type: spine
title: "Step 2: Find Similar People"
readingTime: 3
standalone: true
core: true
teaser: "Who has the same taste? Find your movie twins."
voice: universal
parent: null
diagram: null
---

Now comes the detective work. You've got your rating matrix. Time to figure out: **who has similar taste?**

Let's look at an example. Here are three people's ratings:

| | Frozen | Moana | Encanto | Spider-Verse |
|---|---|---|---|---|
| Alex | 5 | 4 | 5 | 3 |
| Sam | 5 | 5 | 4 | 3 |
| Jordan | 2 | 2 | 1 | 5 |

Look at Alex and Sam. They both gave Frozen 5 stars. They both gave Spider-Verse 3 stars. Their Moana and Encanto ratings are close too. Alex and Sam have **similar taste**.

Now look at Alex and Jordan. Alex loves Frozen (5 stars), Jordan doesn't (2 stars). Alex likes Moana (4), Jordan doesn't (2). They're basically opposites. Alex and Jordan have **different taste**.

**Here's where the magic happens.**

Say Sam hasn't seen Inside Out 2, but Alex rated it 5 stars. Since Alex and Sam have similar taste, we can predict: **Sam will probably like Inside Out 2 too!**

And if Jordan rated a movie 5 stars that Alex hasn't seen? We should probably NOT recommend it to Alex, because Jordan and Alex have opposite taste.

**How to find similar people (the simple way):**

For each pair of people, look at the movies they BOTH rated. Then check how close their ratings are.

Alex vs Sam (movies both rated):
- Frozen: Alex 5, Sam 5 (difference = 0)
- Moana: Alex 4, Sam 5 (difference = 1)
- Encanto: Alex 5, Sam 4 (difference = 1)
- Spider-Verse: Alex 3, Sam 3 (difference = 0)
- **Average difference: 0.5** (very similar!)

Alex vs Jordan (movies both rated):
- Frozen: Alex 5, Jordan 2 (difference = 3)
- Moana: Alex 4, Jordan 2 (difference = 2)
- Spider-Verse: Alex 3, Jordan 5 (difference = 2)
- **Average difference: 2.3** (very different!)

Lower average difference = more similar taste. It's that simple.

**Do this for every pair of people in your grid.** You'll end up with a list of who's most similar to who. These are your "taste neighbors" -- and they're the key to making predictions.

**Think about it!** In your own data, who turned out to be the most similar pair? Were you surprised? Sometimes people you'd never expect turn out to have identical movie taste.
