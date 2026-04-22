/**
 * Mock restaurant and menu data for the MVP demo.
 *
 * Runs the entire ordering flow without needing MealMe API keys. When you
 * integrate MealMe, replace the functions at the bottom of this file — the
 * shape is already compatible with what the tools expect.
 *
 * Prices are in cents. ETAs in minutes. All restaurants are fictionalized
 * Austin-style spots for the demo.
 */

import type { Cuisine, MenuItem, Restaurant } from "./types";

interface RestaurantWithMenu extends Restaurant {
  menu: MenuItem[];
}

const RESTAURANTS: RestaurantWithMenu[] = [
  {
    id: "r_homeslice",
    name: "Homeslice Pizza Co.",
    cuisine: ["pizza", "american"],
    rating: 4.7,
    review_count: 2134,
    price_level: 2,
    distance_miles: 1.2,
    eta_minutes: 28,
    is_open: true,
    tags: ["late night", "new york style", "vegan options"],
    menu: [
      {
        id: "m_hs_pepperoni_lg",
        restaurant_id: "r_homeslice",
        name: "Large Pepperoni Pizza",
        description: "Hand-tossed, 18 inches, classic pepperoni and mozzarella.",
        price_cents: 2199,
        category: "Pizzas",
        modifiers: [
          {
            name: "Crust",
            default: "Hand-tossed",
            options: [
              { label: "Hand-tossed", delta_cents: 0 },
              { label: "Thin", delta_cents: 0 },
              { label: "Gluten-free", delta_cents: 300 },
            ],
          },
        ],
      },
      {
        id: "m_hs_margherita_lg",
        restaurant_id: "r_homeslice",
        name: "Large Margherita",
        description: "San Marzano tomato, fresh mozzarella, basil.",
        price_cents: 2399,
        category: "Pizzas",
      },
      {
        id: "m_hs_veggie_lg",
        restaurant_id: "r_homeslice",
        name: "Large Garden Veggie",
        description: "Bell pepper, onion, mushroom, olives, tomato.",
        price_cents: 2299,
        category: "Pizzas",
      },
      {
        id: "m_hs_garlic_knots",
        restaurant_id: "r_homeslice",
        name: "Garlic Knots (6 pc)",
        description: "Fresh-baked, garlic butter, parmesan.",
        price_cents: 699,
        category: "Sides",
      },
      {
        id: "m_hs_coke_2l",
        restaurant_id: "r_homeslice",
        name: "Coke (2L)",
        description: "Two liter bottle.",
        price_cents: 399,
        category: "Drinks",
      },
    ],
  },
  {
    id: "r_tacopalace",
    name: "Taco Palace",
    cuisine: ["mexican"],
    rating: 4.8,
    review_count: 3421,
    price_level: 1,
    distance_miles: 0.8,
    eta_minutes: 22,
    is_open: true,
    tags: ["breakfast tacos", "authentic", "vegetarian options"],
    menu: [
      {
        id: "m_tp_breakfast_taco",
        restaurant_id: "r_tacopalace",
        name: "Breakfast Taco",
        description: "Flour tortilla, egg, cheese, choice of meat.",
        price_cents: 349,
        category: "Tacos",
      },
      {
        id: "m_tp_al_pastor",
        restaurant_id: "r_tacopalace",
        name: "Al Pastor Taco",
        description: "Marinated pork, pineapple, onion, cilantro.",
        price_cents: 399,
        category: "Tacos",
      },
      {
        id: "m_tp_barbacoa",
        restaurant_id: "r_tacopalace",
        name: "Barbacoa Taco",
        description: "Slow-braised beef, onion, cilantro, lime.",
        price_cents: 449,
        category: "Tacos",
      },
      {
        id: "m_tp_guac_chips",
        restaurant_id: "r_tacopalace",
        name: "Guac & Chips",
        description: "House-made guacamole with tortilla chips.",
        price_cents: 799,
        category: "Sides",
      },
      {
        id: "m_tp_horchata",
        restaurant_id: "r_tacopalace",
        name: "Horchata",
        description: "Traditional rice and cinnamon drink.",
        price_cents: 449,
        category: "Drinks",
      },
    ],
  },
  {
    id: "r_curryhouse",
    name: "Curry House Austin",
    cuisine: ["indian"],
    rating: 4.6,
    review_count: 987,
    price_level: 2,
    distance_miles: 2.4,
    eta_minutes: 35,
    is_open: true,
    tags: ["north indian", "vegetarian", "vegan options"],
    menu: [
      {
        id: "m_ch_butter_chicken",
        restaurant_id: "r_curryhouse",
        name: "Butter Chicken",
        description: "Creamy tomato-based curry with tender chicken.",
        price_cents: 1699,
        category: "Curries",
        modifiers: [
          {
            name: "Spice",
            default: "Medium",
            options: [
              { label: "Mild", delta_cents: 0 },
              { label: "Medium", delta_cents: 0 },
              { label: "Hot", delta_cents: 0 },
              { label: "Extra hot", delta_cents: 0 },
            ],
          },
        ],
      },
      {
        id: "m_ch_paneer_tikka",
        restaurant_id: "r_curryhouse",
        name: "Paneer Tikka Masala",
        description: "Grilled paneer in a spiced tomato cream sauce.",
        price_cents: 1599,
        category: "Curries",
      },
      {
        id: "m_ch_biryani",
        restaurant_id: "r_curryhouse",
        name: "Chicken Biryani",
        description: "Basmati rice layered with spiced chicken and saffron.",
        price_cents: 1799,
        category: "Rice",
      },
      {
        id: "m_ch_garlic_naan",
        restaurant_id: "r_curryhouse",
        name: "Garlic Naan",
        description: "Tandoor-baked flatbread with garlic and butter.",
        price_cents: 399,
        category: "Breads",
      },
      {
        id: "m_ch_mango_lassi",
        restaurant_id: "r_curryhouse",
        name: "Mango Lassi",
        description: "Yogurt, mango pulp, cardamom.",
        price_cents: 499,
        category: "Drinks",
      },
    ],
  },
  {
    id: "r_thaispice",
    name: "Thai Spice Kitchen",
    cuisine: ["thai"],
    rating: 4.5,
    review_count: 612,
    price_level: 2,
    distance_miles: 1.7,
    eta_minutes: 31,
    is_open: true,
    tags: ["pad thai", "curries", "gluten-free options"],
    menu: [
      {
        id: "m_ts_pad_thai",
        restaurant_id: "r_thaispice",
        name: "Pad Thai",
        description: "Rice noodles, egg, peanuts, bean sprouts, lime.",
        price_cents: 1499,
        category: "Noodles",
        modifiers: [
          {
            name: "Protein",
            default: "Chicken",
            options: [
              { label: "Chicken", delta_cents: 0 },
              { label: "Tofu", delta_cents: 0 },
              { label: "Shrimp", delta_cents: 300 },
              { label: "Beef", delta_cents: 200 },
            ],
          },
        ],
      },
      {
        id: "m_ts_green_curry",
        restaurant_id: "r_thaispice",
        name: "Green Curry",
        description: "Coconut milk, Thai basil, eggplant, bamboo shoots.",
        price_cents: 1599,
        category: "Curries",
      },
      {
        id: "m_ts_tom_kha",
        restaurant_id: "r_thaispice",
        name: "Tom Kha Soup",
        description: "Coconut-galangal soup with mushrooms.",
        price_cents: 899,
        category: "Soups",
      },
      {
        id: "m_ts_thai_tea",
        restaurant_id: "r_thaispice",
        name: "Thai Iced Tea",
        description: "Sweet black tea with condensed milk.",
        price_cents: 399,
        category: "Drinks",
      },
    ],
  },
  {
    id: "r_dragonwok",
    name: "Dragon Wok",
    cuisine: ["chinese"],
    rating: 4.3,
    review_count: 1203,
    price_level: 2,
    distance_miles: 2.1,
    eta_minutes: 29,
    is_open: true,
    tags: ["szechuan", "family style", "lunch special"],
    menu: [
      {
        id: "m_dw_kung_pao",
        restaurant_id: "r_dragonwok",
        name: "Kung Pao Chicken",
        description: "Diced chicken, peanuts, dried chilies, Sichuan peppercorn.",
        price_cents: 1499,
        category: "Entrees",
      },
      {
        id: "m_dw_mapo_tofu",
        restaurant_id: "r_dragonwok",
        name: "Mapo Tofu",
        description: "Silken tofu in spicy fermented bean sauce.",
        price_cents: 1299,
        category: "Entrees",
      },
      {
        id: "m_dw_fried_rice",
        restaurant_id: "r_dragonwok",
        name: "Yangzhou Fried Rice",
        description: "Shrimp, egg, peas, char siu pork.",
        price_cents: 1199,
        category: "Rice & Noodles",
      },
      {
        id: "m_dw_potstickers",
        restaurant_id: "r_dragonwok",
        name: "Potstickers (6 pc)",
        description: "Pork and chive, pan-seared.",
        price_cents: 799,
        category: "Appetizers",
      },
    ],
  },
  {
    id: "r_smokehouse",
    name: "Salt Lick Smokehouse",
    cuisine: ["american"],
    rating: 4.9,
    review_count: 4567,
    price_level: 3,
    distance_miles: 3.5,
    eta_minutes: 42,
    is_open: true,
    tags: ["bbq", "texas", "brisket"],
    menu: [
      {
        id: "m_sh_brisket_plate",
        restaurant_id: "r_smokehouse",
        name: "Brisket Plate",
        description: "Half pound brisket, two sides, pickles and onions.",
        price_cents: 2499,
        category: "Plates",
      },
      {
        id: "m_sh_ribs_plate",
        restaurant_id: "r_smokehouse",
        name: "Pork Ribs Plate",
        description: "Three-bone rack, two sides, Texas toast.",
        price_cents: 2299,
        category: "Plates",
      },
      {
        id: "m_sh_pulled_pork",
        restaurant_id: "r_smokehouse",
        name: "Pulled Pork Sandwich",
        description: "Smoked pork, slaw, pickles, brioche bun.",
        price_cents: 1399,
        category: "Sandwiches",
      },
      {
        id: "m_sh_mac_cheese",
        restaurant_id: "r_smokehouse",
        name: "Mac & Cheese",
        description: "Three-cheese blend, breadcrumb top.",
        price_cents: 699,
        category: "Sides",
      },
    ],
  },
  {
    id: "r_sushizen",
    name: "Sushi Zen",
    cuisine: ["japanese"],
    rating: 4.7,
    review_count: 823,
    price_level: 3,
    distance_miles: 2.8,
    eta_minutes: 38,
    is_open: true,
    tags: ["omakase", "sashimi", "gluten-free options"],
    menu: [
      {
        id: "m_sz_dragon_roll",
        restaurant_id: "r_sushizen",
        name: "Dragon Roll",
        description: "Eel, avocado, cucumber, eel sauce.",
        price_cents: 1699,
        category: "Rolls",
      },
      {
        id: "m_sz_spicy_tuna",
        restaurant_id: "r_sushizen",
        name: "Spicy Tuna Roll",
        description: "Tuna, sriracha mayo, scallion.",
        price_cents: 1399,
        category: "Rolls",
      },
      {
        id: "m_sz_salmon_nigiri",
        restaurant_id: "r_sushizen",
        name: "Salmon Nigiri (2 pc)",
        description: "Fresh Atlantic salmon over seasoned rice.",
        price_cents: 899,
        category: "Nigiri",
      },
      {
        id: "m_sz_miso",
        restaurant_id: "r_sushizen",
        name: "Miso Soup",
        description: "Tofu, wakame, green onion.",
        price_cents: 499,
        category: "Starters",
      },
    ],
  },
  {
    id: "r_medgrille",
    name: "Olive Grove Mediterranean",
    cuisine: ["mediterranean"],
    rating: 4.5,
    review_count: 567,
    price_level: 2,
    distance_miles: 1.5,
    eta_minutes: 26,
    is_open: true,
    tags: ["gyros", "hummus", "vegan options"],
    menu: [
      {
        id: "m_mg_chicken_gyro",
        restaurant_id: "r_medgrille",
        name: "Chicken Gyro Plate",
        description: "Grilled chicken, pita, tzatziki, Greek salad, rice.",
        price_cents: 1699,
        category: "Plates",
      },
      {
        id: "m_mg_falafel_bowl",
        restaurant_id: "r_medgrille",
        name: "Falafel Bowl",
        description: "Falafel, hummus, tabbouleh, cucumber, pita.",
        price_cents: 1399,
        category: "Plates",
      },
      {
        id: "m_mg_hummus_dip",
        restaurant_id: "r_medgrille",
        name: "Hummus & Pita",
        description: "House hummus with warm pita bread.",
        price_cents: 799,
        category: "Starters",
      },
    ],
  },
  {
    id: "r_wakeupcafe",
    name: "Wake Up Cafe",
    cuisine: ["breakfast", "american"],
    rating: 4.6,
    review_count: 1432,
    price_level: 2,
    distance_miles: 0.9,
    eta_minutes: 20,
    is_open: true,
    tags: ["all-day breakfast", "coffee", "brunch"],
    menu: [
      {
        id: "m_wu_avo_toast",
        restaurant_id: "r_wakeupcafe",
        name: "Avocado Toast",
        description: "Sourdough, smashed avocado, everything seasoning, egg.",
        price_cents: 1199,
        category: "Breakfast",
      },
      {
        id: "m_wu_pancakes",
        restaurant_id: "r_wakeupcafe",
        name: "Buttermilk Pancakes (3)",
        description: "Three fluffy pancakes, maple syrup, butter.",
        price_cents: 1099,
        category: "Breakfast",
      },
      {
        id: "m_wu_latte",
        restaurant_id: "r_wakeupcafe",
        name: "Oat Latte",
        description: "Double espresso, steamed oat milk.",
        price_cents: 549,
        category: "Coffee",
      },
    ],
  },
  {
    id: "r_sweettooth",
    name: "Sweet Tooth Bakery",
    cuisine: ["dessert"],
    rating: 4.8,
    review_count: 734,
    price_level: 2,
    distance_miles: 1.4,
    eta_minutes: 24,
    is_open: true,
    tags: ["ice cream", "cookies", "late night"],
    menu: [
      {
        id: "m_st_brownie_sundae",
        restaurant_id: "r_sweettooth",
        name: "Warm Brownie Sundae",
        description: "Fudge brownie, vanilla ice cream, hot fudge, whipped cream.",
        price_cents: 999,
        category: "Sundaes",
      },
      {
        id: "m_st_cookie_dozen",
        restaurant_id: "r_sweettooth",
        name: "Cookie Assortment (Dozen)",
        description: "Twelve fresh cookies: chocolate chip, oatmeal, snickerdoodle.",
        price_cents: 1899,
        category: "Cookies",
      },
    ],
  },
];

// ----- Public accessors (the tools call these) ------------------------------

export function searchRestaurantsMock(args: {
  query?: string;
  cuisine?: Cuisine;
  sort?: "rating" | "distance" | "eta" | "price_low";
  max_eta_minutes?: number;
  limit?: number;
}): Restaurant[] {
  let results = [...RESTAURANTS];

  if (args.cuisine) {
    results = results.filter((r) => r.cuisine.includes(args.cuisine!));
  }

  if (args.query) {
    const q = args.query.toLowerCase();
    results = results.filter((r) => {
      const inName = r.name.toLowerCase().includes(q);
      const inTags = r.tags.some((t) => t.toLowerCase().includes(q));
      const inCuisine = r.cuisine.some((c) => c.includes(q));
      const inMenu = r.menu.some((m) =>
        m.name.toLowerCase().includes(q)
      );
      return inName || inTags || inCuisine || inMenu;
    });
  }

  if (args.max_eta_minutes) {
    results = results.filter((r) => r.eta_minutes <= args.max_eta_minutes!);
  }

  const sort = args.sort ?? "rating";
  results.sort((a, b) => {
    switch (sort) {
      case "rating":
        return b.rating - a.rating;
      case "distance":
        return a.distance_miles - b.distance_miles;
      case "eta":
        return a.eta_minutes - b.eta_minutes;
      case "price_low":
        return a.price_level - b.price_level;
    }
  });

  const limit = args.limit ?? 5;
  return results.slice(0, limit).map(stripMenu);
}

export function getRestaurantByIdMock(id: string): Restaurant | null {
  const r = RESTAURANTS.find((x) => x.id === id);
  return r ? stripMenu(r) : null;
}

export function getMenuMock(restaurantId: string): MenuItem[] {
  const r = RESTAURANTS.find((x) => x.id === restaurantId);
  return r ? r.menu : [];
}

export function findItemMock(
  restaurantId: string,
  itemId: string
): MenuItem | null {
  const r = RESTAURANTS.find((x) => x.id === restaurantId);
  return r?.menu.find((m) => m.id === itemId) ?? null;
}

function stripMenu(r: RestaurantWithMenu): Restaurant {
  const { menu: _, ...rest } = r;
  return rest;
}
