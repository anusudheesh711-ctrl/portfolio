/* ==========================================================================
   SITE CONTENT: edit this file to update projects and contact links.
   Everything the page renders dynamically comes from here.
   ========================================================================== */

window.SITE_CONTENT = {
  // Main Behance profile, used by "See all projects on Behance" and Contact.
  behanceProfile: "https://www.behance.net/anursudheesh",

  contact: {
    email: "anusudheesh32@gmail.com",
    phone: "8301950895",       // shown on the page
    phoneHref: "8301950895",   // used in the tel: link (add a country code like +91 if you like)
    linkedin: "https://www.linkedin.com/in/anu-r-sudheesh-792143170/",
  },

  /* Selected Work cards.
     - cover: path to an image in /img (swap the SVG placeholders for real
       JPG/PNG/WebP covers, ideally 1600x1200, 4:3).
     - alt:   describe the cover image for screen reader users.
     - tags:  short labels shown on the card.
     - url:   the project page on Behance. */
  projects: [
    {
      title: "Flora - Custom Bouquet Builder",
      description: "Designed an intuitive mobile commerce experience and custom ordering workflow for a multi-vendor floral marketplace, solving friction in multi-step floral personalization.",
      tags: ["Product Design", "Figma"],
      cover: "./img/Cover1.png",
      alt: "Cover image for Flora Bouquet Builder case study",
      url: "https://www.behance.net/gallery/234636233/Flora-A-Custom-Bouquet-Builder-UIUX-Case-Study",
    },
    {
      title: "Kāalika - Handloom Saree Storefront",
      description: "Product design for a working handloom retailer moving from Instagram DMs to a real storefront. I designed an editorial shopping experience, a search-code lookup for social media customers, and a blouse preview feature.",
      tags: ["Product Design", "E-commerce", "UX Research", "Figma"],
      cover: "./img/Cover2.png",
      alt: "Kāalika case study cover showing the black handloom saree storefront design",
      url: "https://www.behance.net/gallery/256581551/Kaalika-Product-Design-for-Working-Handloom-Retailer",
    },
    {
      title: "WanderNest - Tailored Experience & Travel Discovery",
      description: "Built a functional, multi-device travel discovery portal that matches travelers with curated destinations based on their travel style personas and budget preferences, utilizing CSS layout configurations and parallax scrolling for seamless immersion.",
      tags: ["Frontend", "Prototyping"],
      cover: "./img/Cover3.png",
      alt: "Cover for WanderNest Travel website ",
      url: "https://www.behance.net/gallery/256090467/Parallax-Responsive-Travel-Website-HTML-CSS",
    },
  ],
};
