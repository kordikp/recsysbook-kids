---
id: ch3-deep-similarity
type: spine
title: "How Computers Understand Similarity"
readingTime: 3
standalone: true
core: true
teaser: "A rock song and a jazz song might feel similar — warm, relaxing, acoustic. How does a computer learn to 'feel' that?"
voice: universal
parent: null
diagram: diagram-embedding-space
recallQ: "What are \"embeddings\" in recommendation systems?"
recallA: "Items turned into lists of numbers (vectors). Close vectors = similar items. Neural networks learn these patterns."
status: accepted
---

You can instantly tell that two songs "feel similar" even if they're different genres. A computer can't feel anything — so how does it understand similarity?

## The Old Way: Tags and Categories

Early systems used labels: "This movie is Action + Sci-Fi, that movie is Action + Thriller — they share Action, so they're 60% similar."

The problem? Labels are rough. Two "Comedy" movies might be completely different. And who decides the labels?

## The New Way: Embeddings

Modern systems use **embeddings** — turning items into lists of numbers (vectors) that capture their "essence."

Imagine every song as a point in a room:
- The X axis represents energy (calm → intense)
- The Y axis represents mood (sad → happy)
- The Z axis represents acoustic vs electronic

Two songs close together in this "room" are similar — even if they're different genres. A calm acoustic folk song might be near a calm acoustic jazz song.

## How Deep Learning Finds These Numbers

**Neural networks** learn these numbers by looking at millions of examples:

1. Feed the network pairs: "These two items were liked by the same user" or "This image looks like that image"
2. The network learns to place similar items close together and different items far apart
3. After training, every item gets a **vector** — its address in the similarity space

This is how Spotify's "Discover Weekly" finds songs you've never heard that perfectly match your taste. It's not matching genre labels — it's matching the mathematical *feeling* of the music.

## Why This Solves Cold Start

Modern recommender systems like [Recombee](https://www.recombee.com/blog/modern-recommender-systems-part-2-data) create embeddings from item descriptions, images, and user behavior all at once. This means a new item with just a title and description can immediately be matched to users who would like it — no ratings needed.

**Why this matters for you**: When a recommendation feels eerily perfect — like the app "gets" you — it's because deep learning found the hidden patterns that connect your taste to new content. It's not reading your mind. It's reading millions of people's behavior and finding the mathematical structure of preference.
