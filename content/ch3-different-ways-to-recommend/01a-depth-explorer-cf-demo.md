---
id: ch3-cf-d-exp
type: spine
title: "See Collaborative Filtering in Action"
readingTime: 3
standalone: false
teaser: "A visual grid that shows exactly how the system finds your taste twins."
voice: explorer
parent: null
diagram: diagram-cf-matrix
recallQ: "What are \"taste twins\" in collaborative filtering?"
recallA: "People who liked the same things as you. If they also liked something new, you probably will too!"
status: accepted
---

Let's build a real example. Imagine six kids and five movies. A checkmark means they liked the movie:

|  | Spider-Verse | Encanto | Mitchells | Turning Red | Nimona |
|---|---|---|---|---|---|
| **You** | YES | YES | YES | YES | ??? |
| **Maya** | YES | YES | YES | YES | YES |
| **Jake** | YES |  | YES |  | YES |
| **Priya** |  | YES |  | YES |  |
| **Leo** | YES | YES | YES | YES | YES |
| **Sam** |  |  | YES |  | YES |

## Step 1: Find Your Taste Twins

Look at the grid. Who likes the same movies as you?

- **Maya**: matches you on ALL four movies. Perfect match!
- **Leo**: also matches on all four. Another perfect match!
- **Jake**: matches on two out of four. Pretty good.
- **Priya**: matches on two out of four. Okay.
- **Sam**: matches on only one. Not a great match.

The system ranks everyone by how closely they match you. Maya and Leo are at the top.

## Step 2: Check What Your Twins Liked

Now look at the "Nimona" column for your best matches:

- Maya liked Nimona -- YES
- Leo liked Nimona -- YES

Both of your closest taste twins loved it!

## Step 3: Make the Recommendation

The system is now pretty confident: **you'll like Nimona too**.

It's not 100% guaranteed. Maybe you won't like it. But based on the pattern, it's a really strong guess.

## Try It Yourself

Look at the grid again. What would you recommend to **Priya**? She liked Encanto and Turning Red. Who else liked those two movies? You, Maya, and Leo. What else did all three of you like? Spider-Verse and Mitchells! So the system would recommend those to Priya.

That's the whole trick. Find similar people, see what they liked, recommend it. Simple -- but incredibly powerful when you do it with millions of users.
