import { generateSlides } from "./server/slideGenerator.ts";

async function test() {
  try {
    console.log("Testing slide generation for project 180004...");
    const slideUrl = await generateSlides(180004);
    console.log("Success! Slide URL:", slideUrl);
  } catch (error) {
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
  }
}

test();
