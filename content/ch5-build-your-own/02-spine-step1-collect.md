---
id: ch5-collect
type: spine
title: "Step 1: Collect the Data"
readingTime: 3
standalone: true
core: true
teaser: "Survey your friends, build a rating grid, and watch the pattern emerge."
voice: universal
parent: null
diagram: null
---

Every recommendation system starts with data. And YOUR data is going to come from real people -- your friends, family, classmates, anyone you can convince to answer a quick survey.

**The Survey:**

Pick **10 movies** that most people have heard of. Mix it up -- some action, some comedy, some animated, some older, some new. Here's an example list:

1. Frozen
2. Spider-Man: Across the Spider-Verse
3. Moana
4. The Super Mario Bros. Movie
5. Encanto
6. Wonka
7. Inside Out 2
8. Kung Fu Panda 4
9. Dune
10. Ghostbusters: Frozen Empire

Now find **at least 10 people** and ask each one:

"Rate each movie from 1 to 5 stars. If you haven't seen it, leave it blank."

- 1 star = hated it
- 2 stars = didn't like it
- 3 stars = it was okay
- 4 stars = liked it
- 5 stars = loved it

**Build Your Grid:**

Draw a big grid. People down the left side. Movies across the top. Fill in the ratings.

| | Frozen | Spider-Verse | Moana | Mario | Encanto |
|---|---|---|---|---|---|
| Alex | 5 | 4 | 5 | 3 | 4 |
| Sam | 5 | 3 | 5 | | 5 |
| Jordan | 2 | 5 | 3 | 5 | |
| Maya | 4 | | 4 | 4 | 3 |
| Leo | | 5 | | 5 | 2 |

See those empty cells? Those are movies the person hasn't seen. And those empty cells are exactly what your recommendation system is going to **predict**.

This grid has a fancy name: it's called a **rating matrix**. And it's the foundation of your entire recommendation system.

**Notice something?** Most of the grid is probably empty. People haven't seen every movie. That's normal -- and it's actually the whole point. If everyone had seen everything, there would be nothing to recommend!

**Think about it!** Look at your grid. Can you already spot people who seem to have similar taste? Just by scanning the numbers, you might see patterns. That's your brain doing what the algorithm is about to do -- but with math.
