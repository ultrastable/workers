# Help

Plain-language help for the person who owns the organization. The console Help tab and the README written at bootstrap are both generated from this file by `tools/build_help.mjs`, and `core/test/help.test.js` fails when they drift.

## What this is

Your organization is a team of software workers that plan, build and check work on your behalf. They run by themselves on a schedule. This console shows what they are doing and the few things only you can do.

## The four screens

Now shows what is being worked on and what is stuck. Needs you lists the decisions and steps only a person can take. Progress shows what was finished lately and how often the system's own predictions came true. Connect is where you add the keys that let the workers use outside services.

## What does "Needs you" mean

Each card is one thing the workers cannot or should not do for you, such as paying for something or creating an account in your name. Every card says what happens if you do nothing. The workers keep going on everything else either way, so a card never stops the whole system.

## Keys and secrets

A key is a private code from another service. Paste it once in Connect. It is stored privately and never shown again, not even to you. If a key is lost or leaked, paste a new one in the same place and the old one stops working.

## Asking for something

Type what you want in your own words in the box at the bottom, or use one of the suggestions. Your request becomes a work item with an owner and a way to check it is done.

## When something looks wrong

The line at the top says whether the last check finished. If it says something needs attention, open Now and read the stuck items: each one names what is blocking it. The workers retry on the next check, and nothing is deleted.
