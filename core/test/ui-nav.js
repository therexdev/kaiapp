"use strict";

// Use the same group headers a person clicks before choosing a destination.
async function navClick(page, selector) {
  const groupId = await page.locator(selector).evaluate(el => el.closest(".nav-group")?.querySelector(".nav-group-label")?.id || null);
  if (groupId) {
    const header = page.locator("#" + groupId);
    if (await header.getAttribute("aria-expanded") !== "true") await header.click();
  }
  await page.click(selector);
}

module.exports = { navClick };
