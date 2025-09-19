use std::collections::HashMap;

use voxelize::{MinecraftAnvilStage, Registry, World, WorldConfig};

pub fn setup_minecraft_world(registry: &Registry, world_dir: &str) -> World {
    let config = WorldConfig::new()
        .chunk_size(16)
        .max_height(256)
        .saving(false)
        .preload(true)
        .preload_radius(2)
        .build();

    let mut world = World::new("minecraft-import", &config);

    let mut mapping = HashMap::new();
    mapping.insert("minecraft:stone".to_owned(), "Stone".to_owned());
    mapping.insert("minecraft:dirt".to_owned(), "Dirt".to_owned());
    mapping.insert("minecraft:grass_block".to_owned(), "Grass Block".to_owned());
    mapping.insert("minecraft:sand".to_owned(), "Sand".to_owned());
    mapping.insert("minecraft:oak_log".to_owned(), "Oak Log".to_owned());
    mapping.insert("minecraft:oak_leaves".to_owned(), "Oak Leaves".to_owned());
    mapping.insert("minecraft:oak_planks".to_owned(), "Oak Planks".to_owned());

    let default_block = registry.get_block_by_name("Stone").id;

    let stage = MinecraftAnvilStage::new(world_dir)
        .with_mapping(mapping)
        .with_default_block(default_block);

    {
        let mut pipeline = world.pipeline_mut();
        pipeline.add_stage(stage);
    }

    world
}
