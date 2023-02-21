import { Adapters } from '../src/index.js';

const registry = new Adapters();

const newMenuItem = (label) => ({ label, action: (file) => console.log(`[${label}] ${file.type}`) })

// Register an adapter providing new menu operations for files: copy, delete and move:
const menuFileAdapter = {
  type : "file",
  menuItems: [
    { label: "Copy File", action: (file) => console.log(`  - Creating a "${file.path} Copy" file...`) },
    { label: "Delete File", action: (file) => console.log(`  - Moving file "${file.path}" around...`) },
    { label: "Move File", action: (file) => console.log(`  - Moving file "${file.path}" around...`) },
  ]
}
registry.set("menu", menuFileAdapter.type, menuFileAdapter)

// Register image-specific operations - resize and share: 
const menuImageAdapter = {
  type : "file.image",
  menuItems: [
    { label: "Resize Image", action: (file) => console.log(`  - Resizing "${file.path}"...`) },
    { label: "Share Image", action: (file) => console.log(`  - Sending "${file.path}" to Instagram...`) }
  ]
}
registry.set("menu",menuImageAdapter.type, menuImageAdapter);

// Define a list of files:
const files = [
  { type: "file.document", path: "documents/MyDocument.txt" },
  { type: "file.image", path: "about/ProfilePicture.jpg" },
]

// Now we can show operations for each file in the menu context:
const context = "menu";
for (let file of files) {
  console.log("---------------------------------")
  console.log(`# "${file.path}":`);
  const adapters = registry.getAll(context, file.type);
  for (const adapter of adapters) {
    console.log(`Type "${adapter.type}":`);
    for (let menuItem of adapter.menuItems) {
      menuItem.action(file);
    }
  }
}
