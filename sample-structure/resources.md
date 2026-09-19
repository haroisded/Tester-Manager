# Resources — acceptance tests

Covers the **Resources** group in the side menu and its three screens: **Products**, **Rentables** and
**Inventory**, with their Setup, add, edit, archive, restore and delete.

## Test 1 - Title: Resources opens and closes its three screens

### What will be tested?
That tapping **Resources** in the side menu only shows or hides the three screens under it.

### What do you need before starting?
- Signed in, inside a system, on a phone.

### Steps
1. Open the side menu.
2. Tap **Resources**.
3. Look under **Resources**.
4. Tap **Resources** again.

### What's the expected output?
- After step 2, **Products**, **Rentables** and **Inventory** appear under **Resources**, and the page behind the menu does not change.
- After step 4, the three entries are hidden again.

## Test 2 - Title: Resources on a tablet

### What will be tested?
The same menu on the narrow tablet side bar.

### What do you need before starting?
- Signed in, inside a system, on a tablet wide enough to show the side bar as a permanent rail,
  collapsed to icons. (The app is locked to portrait, so do not rotate it — if the rail is not
  showing, this tablet is too narrow and the test does not apply.)

### Steps
1. Tap the **Resources** icon.
2. Tap **Rentables**.

### What's the expected output?
- Step 1 widens the side bar and shows the three entries.
- Step 2 opens the Rentables list with the title **Rentables**.

## Test 3 - Title: Each screen shows only its own kind of item

### What will be tested?
That Products, Rentables and Inventory do not mix their items.

### What do you need before starting?
- Test 5 and Test 8 done (a service in Products and a rental in Rentables exist).

### Steps
1. Open **Products**.
2. Look at the list.
3. Open **Rentables**.
4. Look at the list.
5. Open **Inventory**.
6. Look at the list.

### What's the expected output?
- Products shows only **Flat Service** items.
- Rentables shows only **Rental Asset** and **Bookable Service** items.
- Inventory shows only **Stock / Consumable** items.

## Test 4 - Title: Setup shows only the lists that screen uses

### What will be tested?
That each screen's **Setup** has its own lists and categories.

### What do you need before starting?
- Signed in, inside a system.

### Steps
1. Open **Products**, tap **Setup**.
2. Add a category called **Services A**.
3. Go back, open **Inventory**, tap **Setup**.
4. Look at the categories.
5. Look at which lists are shown.

### What's the expected output?
- Products Setup shows **Categories** and **Tax classes**, no suppliers.
- Inventory Setup shows **Categories** and **Suppliers**, no tax classes.
- **Services A** is not in Inventory's categories.

## Test 5 - Title: Record 1 — add a service and save it as active

### What will be tested?
Creating a product and choosing how it saves at the last step.

### What do you need before starting?
- On the **Products** screen, internet on.

### Steps
1. Tap **Add product**.
2. Type the name **Delivery fee**.
3. Tap **Next** until the last step, **Review**.
4. Look at the buttons at the bottom.
5. Tap **Save as active**.

### What's the expected output?
- Step 4 shows **Save as draft**, **Save as active** and **Cancel**, and no "Save as" switch above them.
- After step 5, the product's page opens with the badge **Active** and a message **Product saved** with **Add another**.

## Test 6 - Title: Record 1 — edit, then view

### What will be tested?
Editing an active product keeps it active.

### What do you need before starting?
- Test 5 done, on **Delivery fee**'s page.

### Steps
1. Tap **Edit**.
2. Change the name to **Delivery fee (city)**.
3. Go to the **Review** step.
4. Look at the buttons.
5. Tap **Save changes**.

### What's the expected output?
- Step 4 shows **Save changes** and **Cancel** only.
- After step 5 the page shows **Delivery fee (city)** with the badge still **Active**.

## Test 7 - Title: Record 1 — archive, restore, delete

### What will be tested?
Archive and Delete are separate, and an archived item can be restored.

### What do you need before starting?
- Test 6 done, on **Delivery fee (city)**'s page.

### Steps
1. Tap **Archive**.
2. Look at the screen.
3. Tap **Restore**.
4. Look at the badge and the message.
5. Tap **Delete**.
6. Tap **Delete** in the box that opens.

### What's the expected output?
- Step 1 does not open any "Delete permanently" box; a message **Delivery fee (city) archived** with **Undo** appears, the badge reads **Archived**, and the **Archive** button now reads **Restore**.
- After step 3 the message reads **Delivery fee (city) restored as a draft** and the badge reads **Draft**.
- Step 5 opens a box headed **Delete permanently**.
- After step 6 the app goes back to the list and the item is gone.

## Test 8 - Title: Record 2 — a rental asks its type first

### What will be tested?
Rentables asks Rental or Bookable before showing the form, and the type cannot change later.

### What do you need before starting?
- On the **Rentables** screen.

### Steps
1. Tap **Add rentable**.
2. Look at the screen.
3. Tap **Rental Asset**.
4. Type the name **Mountain bike**.
5. Go to the **Review** step.
6. Tap **Save as draft**.

### What's the expected output?
- Step 2 shows a choice between **Rental Asset** and **Bookable Service**, and no form yet.
- The form never offers a way to change the type.
- After step 6 the bike's page opens with the badge **Draft**.

## Test 9 - Title: Record 2 — edit a draft, then publish

### What will be tested?
A draft can be made active from the edit form.

### What do you need before starting?
- Test 8 done, on **Mountain bike**'s page.

### Steps
1. Tap **Edit**.
2. Go to the **Review** step.
3. Tap **Save as active**.

### What's the expected output?
- Step 2 shows **Save as draft**, **Save as active** and **Cancel**.
- After step 3 the page shows the badge **Active**.

## Test 10 - Title: Record 2 — archive with Undo, then delete

### What will be tested?
Undo puts an archived item back as it was.

### What do you need before starting?
- Test 9 done, on **Mountain bike**'s page.

### Steps
1. Tap **Archive**.
2. Tap **Undo** in the message.
3. Look at the badge.
4. Tap **Delete**, then **Delete** in the box.

### What's the expected output?
- After step 2 the badge reads **Active** again.
- After step 4 the bike is gone from the Rentables list.

## Test 11 - Title: Opening hours use a 12-hour clock

### What will be tested?
Every time is picked and shown as hours, minutes and AM/PM.

### What do you need before starting?
- On **Rentables**, **Add rentable**, **Bookable Service** chosen, on the availability step. Repeat on an iPhone and an Android phone.

### Steps
1. Tap a start time.
2. Look at the picker.
3. Pick **2**, **30**, **PM**.
4. Close the picker.

### What's the expected output?
- The picker has three wheels: hour, minute, AM/PM. No 24-hour clock anywhere.
- The field shows **2:30 PM**.

## Test 12 - Title: Cancel with and without changes

### What will be tested?
Cancel on the last step warns only when something would be lost.

### What do you need before starting?
- On **Products**.

### Steps
1. Tap **Add product**, go to **Review** without typing anything, tap **Cancel**.
2. Tap **Add product**, type the name **Test**, go to **Review**, tap **Cancel**.
3. Tap **Keep editing**.
4. Tap **Cancel** again, then **Discard**.

### What's the expected output?
- Step 1 goes straight back to the list.
- Step 2 opens **Discard your changes?**; step 3 keeps the form with **Test** still typed.
- Step 4 goes back to the list and nothing called **Test** was added.

## Test 13 - Title: Save with a required field empty

### What will be tested?
The form points at what is missing.

### What do you need before starting?
- On **Products**, **Add product**.

### Steps
1. Leave the name empty.
2. Go to **Review**.
3. Tap **Save as active**.

### What's the expected output?
- The **General** row says **Needs attention**, a message says some fields need attention, and the General step opens. Nothing is saved.

## Test 14 - Title: Double-tap Save

### What will be tested?
Tapping Save twice quickly makes one item, not two.

### What do you need before starting?
- On **Products**, a new product named **Double** filled in, on **Review**.

### Steps
1. Tap **Save as active** twice, fast.
2. Go back to the Products list.

### What's the expected output?
- One **Double** in the list. Delete it afterwards.

## Test 15 - Title: Phone Back button in the middle of the form

### What will be tested?
The phone's Back button asks before losing typing.

### What do you need before starting?
- Android phone, on **Inventory**, **Add item**, name typed.

### Steps
1. Press the phone's Back button.

### What's the expected output?
- **Discard your changes?** appears.

## Test 16 - Title: A link to an item from another screen

### What will be tested?
An item cannot be opened under the wrong screen.

### What do you need before starting?
- A developer gives you a link that opens a Rentables item under Products. Skip this test if no one can.

### Steps
1. Open the link.

### What's the expected output?
- **This product is no longer available.** with **Back to the list**. The item's details are not shown.

## Test 17 - Title: Sign out and back in

### What will be tested?
Items survive signing out.

### What do you need before starting?
- Signed in, at least one item in **Products**.

### Steps
1. Sign out while on the Products list.
2. Sign back in as the same person.
3. Open the same system, then **Products**.

### What's the expected output?
- Step 1 lands on sign-in without freezing. Step 3 shows the same items.

## Test 18 - Title: A different person sees none of the first person's items

### What will be tested?
The most important test in this file.

### What do you need before starting?
- Person A has items in all three screens. A second account, Person B.

### Steps
1. Sign out of Person A.
2. Sign in as Person B.
3. Open Products, Rentables and Inventory in each of B's systems.

### What's the expected output?
- **None of Person A's items or categories appear, even for a moment.**

## Test 19 - Title: Delete the account while it has items

### What will be tested?
Account deletion takes the items with it.

### What do you need before starting?
- A throwaway account with one item in each screen.

### Steps
1. Delete the account from Account.
2. Sign up again with the same login.
3. Create a system and open **Products**.

### What's the expected output?
- Step 1 lands on sign-in. Step 3 shows an empty list.

## Test 20 - Title: Internet drops while saving

### What will be tested?
Saving offline gives a clear message.

### What do you need before starting?
- On **Products**, a new product filled in, on **Review**.

### Steps
1. Turn on airplane mode.
2. Tap **Save as active**.
3. Look at the screen.
4. Turn airplane mode off.

### What's the expected output?
- Step 3 says it is waiting for a connection and will save on its own, no endless spinner.
- After step 4 the product's page opens.

## Test 21 - Title: Airplane mode, then open a screen

### What will be tested?
Screens say they are offline instead of going blank.

### What do you need before starting?
- Airplane mode on, app open inside a system.

### Steps
1. Open **Rentables** from the side menu.

### What's the expected output?
- An offline message, not a blank screen or a spinner that never ends.

## Test 22 - Title: Battery dies, or app swiped away, mid-form

### What will be tested?
Nothing is half-saved.

### What do you need before starting?
- On **Inventory**, **Add item**, name typed, not saved.

### Steps
1. Swipe the app away from recent apps (or switch the phone off).
2. Reopen the app.
3. Open **Inventory**.

### What's the expected output?
- Still signed in. The unsaved item is not in the list; nothing broken or partly filled appears.

## Test 23 - Title: Call or notification mid-form, and 10 minutes away

### What will be tested?
Typing survives an interruption.

### What do you need before starting?
- On **Products**, **Add product**, name typed.

### Steps
1. Receive a call (or open a notification), then return to the app.
2. Leave the app in the background for 10 minutes, then return.

### What's the expected output?
- The typed name is still there both times, and no sign-in is asked for.

## Test 24 - Title: Phone storage almost full, and clock wrong

### What will be tested?
The app still works on a phone in poor shape.

### What do you need before starting?
- A phone with almost no free storage, then the same phone with its clock set 5 minutes off.

### Steps
1. Add and save a product.
2. With the clock off, sign out and sign in with Google.

### What's the expected output?
- Step 1 saves normally.
- Step 2 may fail; write down the exact message shown.

## Test 25 - Title: Phone and tablet layouts

### What will be tested?
The Review step and the item page fit both sizes.

### What do you need before starting?
- A phone and a tablet.

### Steps
1. On the phone, reach **Review** in Add product.
2. On the tablet, do the same.
3. On each, open an archived item's page.

### What's the expected output?
- Phone: the three buttons are stacked full width at the bottom, none cut off.
- Tablet: **Cancel**, **Save as draft**, **Save as active** sit in the top bar, with the steps listed on the left.
- Both show **Restore** instead of **Archive** on the archived item.
