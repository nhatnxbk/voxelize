use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::RwLock;

use byteorder::{BigEndian, ByteOrder};
use fastnbt::from_bytes;
use libflate::{gzip::Decoder as GzipDecoder, zlib::Decoder as ZlibDecoder};
use log::warn;
use serde::Deserialize;

use crate::{Chunk, Registry, Resources, VoxelAccess};

use super::ChunkStage;

const REGION_SIZE: i32 = 32;
const SECTION_VOLUME: usize = 16 * 16 * 16;

#[derive(Debug, Deserialize)]
struct RawChunk {
    #[serde(rename = "Level")]
    level: Option<RawChunkLevel>,

    #[serde(default, rename = "sections")]
    sections_lower: Option<Vec<RawSection>>,

    #[serde(default, rename = "Sections")]
    sections_upper: Option<Vec<RawSection>>,
}

impl RawChunk {
    fn into_sections(self) -> Vec<RawSection> {
        if let Some(level) = self.level {
            return level.into_sections();
        }

        if let Some(sections) = self.sections_lower {
            return sections;
        }

        if let Some(sections) = self.sections_upper {
            return sections;
        }

        Vec::new()
    }
}

#[derive(Debug, Deserialize)]
struct RawChunkLevel {
    #[serde(default, rename = "Sections")]
    sections_upper: Option<Vec<RawSection>>,

    #[serde(default, rename = "sections")]
    sections_lower: Option<Vec<RawSection>>,
}

impl RawChunkLevel {
    fn into_sections(self) -> Vec<RawSection> {
        if let Some(sections) = self.sections_upper {
            return sections;
        }

        if let Some(sections) = self.sections_lower {
            return sections;
        }

        Vec::new()
    }
}

#[derive(Debug, Deserialize)]
struct RawSection {
    #[serde(rename = "Y")]
    y: i8,

    #[serde(default, rename = "block_states")]
    block_states: Option<Vec<i64>>,

    #[serde(default, rename = "BlockStates")]
    block_states_upper: Option<Vec<i64>>,

    #[serde(default, rename = "palette")]
    palette: Option<Vec<RawPaletteEntry>>,

    #[serde(default, rename = "Palette")]
    palette_upper: Option<Vec<RawPaletteEntry>>,
}

impl RawSection {
    fn palette(&self) -> Option<&[RawPaletteEntry]> {
        self.palette
            .as_deref()
            .or_else(|| self.palette_upper.as_deref())
    }

    fn block_states(&self) -> Option<&[i64]> {
        self.block_states
            .as_deref()
            .or_else(|| self.block_states_upper.as_deref())
    }
}

#[derive(Debug, Deserialize)]
struct RawPaletteEntry {
    #[serde(rename = "Name")]
    name: String,
}

pub struct MinecraftAnvilStage {
    world_path: PathBuf,
    mapping: HashMap<String, String>,
    resolved: RwLock<HashMap<String, u32>>,
    default_block: u32,
    y_offset: i32,
}

impl MinecraftAnvilStage {
    pub fn new<P: Into<PathBuf>>(world_path: P) -> Self {
        Self {
            world_path: world_path.into(),
            mapping: HashMap::new(),
            resolved: RwLock::new(HashMap::new()),
            default_block: 0,
            y_offset: 0,
        }
    }

    pub fn with_mapping(mut self, mapping: HashMap<String, String>) -> Self {
        self.mapping = mapping
            .into_iter()
            .map(|(mc, vx)| (mc.to_lowercase(), vx))
            .collect();
        self
    }

    pub fn with_default_block(mut self, block_id: u32) -> Self {
        self.default_block = block_id;
        self
    }

    pub fn with_y_offset(mut self, offset: i32) -> Self {
        self.y_offset = offset;
        self
    }

    fn resolve_block_id(&self, registry: &Registry, mc_name: &str) -> u32 {
        if mc_name == "minecraft:air" {
            return 0;
        }

        if let Some(id) = self
            .resolved
            .read()
            .ok()
            .and_then(|cache| cache.get(mc_name).copied())
        {
            return id;
        }

        let mapped_name = if let Some(name) = self.mapping.get(&mc_name.to_lowercase()) {
            Some(name.to_owned())
        } else if let Some((_, name)) = mc_name.split_once(':') {
            Some(name.to_owned())
        } else {
            None
        };

        let block_id = mapped_name
            .and_then(|name| {
                registry
                    .blocks_by_name
                    .get(&name.to_lowercase())
                    .map(|b| b.id)
            })
            .unwrap_or(self.default_block);

        if let Ok(mut cache) = self.resolved.write() {
            cache.insert(mc_name.to_owned(), block_id);
        }

        block_id
    }

    fn load_chunk(&self, chunk_x: i32, chunk_z: i32) -> Option<RawChunk> {
        let (region_x, local_x) = split_region_coord(chunk_x);
        let (region_z, local_z) = split_region_coord(chunk_z);

        let region_path = self
            .world_path
            .join("region")
            .join(format!("r.{}.{}.mca", region_x, region_z));

        let mut file = File::open(&region_path).ok()?;
        let mut header = [0u8; 4096];
        file.read_exact(&mut header).ok()?;

        let index = (local_z * REGION_SIZE + local_x) as usize;
        let location = BigEndian::read_u32(&header[index * 4..index * 4 + 4]);

        if location == 0 {
            return None;
        }

        let offset = (location >> 8) as u64 * 4096;
        let sectors = (location & 0xFF) as usize;

        if offset == 0 || sectors == 0 {
            return None;
        }

        file.seek(SeekFrom::Start(offset)).ok()?;

        let mut length_buf = [0u8; 4];
        file.read_exact(&mut length_buf).ok()?;
        let length = BigEndian::read_u32(&length_buf) as usize;

        if length == 0 || length > sectors * 4096 {
            return None;
        }

        let mut compression = [0u8; 1];
        file.read_exact(&mut compression).ok()?;

        let mut payload = vec![0u8; length - 1];
        file.read_exact(&mut payload).ok()?;

        let decompressed = match compression[0] {
            1 => {
                let mut decoder = GzipDecoder::new(&payload[..]).ok()?;
                let mut data = Vec::new();
                decoder.read_to_end(&mut data).ok()?;
                data
            }
            2 => {
                let mut decoder = ZlibDecoder::new(&payload[..]).ok()?;
                let mut data = Vec::new();
                decoder.read_to_end(&mut data).ok()?;
                data
            }
            other => {
                warn!(
                    "Unsupported compression {} for chunk {}, {}",
                    other, chunk_x, chunk_z
                );
                return None;
            }
        };

        from_bytes::<RawChunk>(&decompressed).ok()
    }
}

impl ChunkStage for MinecraftAnvilStage {
    fn name(&self) -> String {
        "Minecraft Anvil Import".to_owned()
    }

    fn process(&self, mut chunk: Chunk, resources: Resources, _: Option<crate::Space>) -> Chunk {
        let Some(raw_chunk) = self.load_chunk(chunk.coords.0, chunk.coords.1) else {
            return chunk;
        };

        let sections = raw_chunk.into_sections();
        let max_height = resources.config.max_height as i32;
        let chunk_min_x = chunk.min.0;
        let chunk_min_z = chunk.min.2;

        for section in sections.iter() {
            let palette = match section.palette() {
                Some(palette) if !palette.is_empty() => palette,
                _ => continue,
            };

            let section_y = section.y as i32;
            let base_y = section_y * 16 + self.y_offset;

            if base_y >= max_height || base_y + 15 < 0 {
                continue;
            }

            let palette_ids: Vec<u32> = palette
                .iter()
                .map(|entry| self.resolve_block_id(resources.registry, &entry.name))
                .collect();

            if palette_ids.is_empty() {
                continue;
            }

            let block_states = section.block_states().unwrap_or(&[]);
            let indices = decode_block_states(block_states, palette_ids.len());

            for (idx, palette_index) in indices.iter().enumerate() {
                if *palette_index >= palette_ids.len() {
                    continue;
                }

                let block_id = palette_ids[*palette_index];

                if block_id == 0 {
                    continue;
                }

                let local_x = (idx & 0xF) as i32;
                let local_z = ((idx >> 4) & 0xF) as i32;
                let local_y = (idx >> 8) as i32;

                let vy = base_y + local_y;

                if vy < 0 || vy >= max_height {
                    continue;
                }

                let vx = chunk_min_x + local_x;
                let vz = chunk_min_z + local_z;

                chunk.set_voxel(vx, vy, vz, block_id);
            }
        }

        chunk
    }
}

fn decode_block_states(data: &[i64], palette_len: usize) -> Vec<usize> {
    if palette_len <= 1 {
        return vec![0; SECTION_VOLUME];
    }

    if data.is_empty() {
        return vec![0; SECTION_VOLUME];
    }

    let bits = bits_for_palette(palette_len);
    let mask = (1u128 << bits) - 1;

    let mut indices = Vec::with_capacity(SECTION_VOLUME);
    let mut accumulator = 0u128;
    let mut bits_in_acc = 0usize;
    let mut iter = data.iter();

    for _ in 0..SECTION_VOLUME {
        while bits_in_acc < bits {
            if let Some(value) = iter.next() {
                accumulator |= (*value as u128) << bits_in_acc;
                bits_in_acc += 64;
            } else {
                indices.resize(SECTION_VOLUME, 0);
                return indices;
            }
        }

        let palette_index = (accumulator & mask) as usize;
        indices.push(palette_index);

        accumulator >>= bits;
        bits_in_acc -= bits;
    }

    indices
}

fn bits_for_palette(palette_len: usize) -> usize {
    let mut bits = 0usize;
    let mut value = palette_len - 1;

    while value > 0 {
        bits += 1;
        value >>= 1;
    }

    bits.max(4)
}

fn split_region_coord(value: i32) -> (i32, i32) {
    let region = if value >= 0 {
        value / REGION_SIZE
    } else {
        (value + 1 - REGION_SIZE) / REGION_SIZE
    };

    let local = value - region * REGION_SIZE;

    (region, ((local % REGION_SIZE) + REGION_SIZE) % REGION_SIZE)
}
