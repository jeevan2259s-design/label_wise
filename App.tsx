import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  StatusBar as RNStatusBar,
  Platform,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

type Screen = 'home' | 'scan' | 'compare' | 'profile' | 'result' | 'details';
type ScanMode = 'barcode' | 'label' | 'gallery';

interface ScannedBarcode {
  data: string;
  type: string;
  scannedAt: string;
}

export interface NutrientsInfo {
  calories: string;
  fat: string;
  saturatedFat: string;
  carbs: string;
  sugars: string;
  fiber: string;
  protein: string;
  salt: string;
}

const BACKEND_URL = 'http://10.220.191.68:5000';

export interface LabelPhoto {
  uri: string;
  base64?: string;
  mimeType?: string;
}

export interface ConflictItem {
  field: string;
  databaseValue: string;
  packagingValue: string;
}

export interface ProductDetails {
  barcode: string;
  name: string;
  brand: string;
  packageSize: string;
  ingredients: string;
  allergens: string;
  nutriScore: string | null;
  novaGroup: number | null;
  imageUrl: string | null;
  servingSize: string | null;
  nutrients: NutrientsInfo;
  source?: 'open_food_facts' | 'package_photo' | 'merged';
  rawOffData?: any;
  rawAiData?: any;
  conflicts?: ConflictItem[];
  missingGaps?: {
    ingredientsMissing: boolean;
    nutritionMissing: boolean;
  };
}

export type AssessmentStatus = 'avoid' | 'caution' | 'no_conflict' | 'unable_to_assess';

export interface AssessmentItem {
  id: string;
  name: string;
  type: 'allergen' | 'goal';
  status: AssessmentStatus;
  statusLabel: string;
  headline: string;
  evidence: string;
  source: string;
  guidanceNote?: string;
  conflictWarning?: string;
}

export interface PersonalizedAssessmentResult {
  overallStatus: AssessmentStatus;
  overallTitle: string;
  overallSummary: string;
  items: AssessmentItem[];
  missingIngredients: boolean;
}

export interface CompatibilityScoreResult {
  score: number | null;
  verdict: 'AVOID' | 'CAUTION' | 'NO IDENTIFIED CONFLICT' | 'INCOMPLETE DATA';
  headlineReason: string;
  hasAllergenConflict: boolean;
  hasIncompleteData: boolean;
  scoreExplanation: string;
}

const calculateCompatibilityScore = (
  assessment: PersonalizedAssessmentResult,
  activePreferencesCount: number
): CompatibilityScoreResult => {
  if (activePreferencesCount === 0) {
    return {
      score: null,
      verdict: 'NO IDENTIFIED CONFLICT',
      headlineReason: 'No active profile filters configured. Customize your profile to get a personalized score.',
      hasAllergenConflict: false,
      hasIncompleteData: false,
      scoreExplanation: 'Score requires at least one active allergy filter or dietary goal in your Health Profile.',
    };
  }

  // If essential ingredients data is missing
  if (assessment.missingIngredients) {
    return {
      score: null,
      verdict: 'INCOMPLETE DATA',
      headlineReason: 'Ingredients panel is missing or unreadable. Allergen safety cannot be verified.',
      hasAllergenConflict: false,
      hasIncompleteData: true,
      scoreExplanation: 'Score cannot be calculated responsibly because ingredients are missing from the packaging scan.',
    };
  }

  // If any allergen conflict exists (AVOID)
  const avoidItems = assessment.items.filter((i) => i.status === 'avoid');
  if (avoidItems.length > 0) {
    const allergenNames = avoidItems.map((i) => i.name).join(', ');
    return {
      score: 0,
      verdict: 'AVOID',
      headlineReason: `Contains or declares ${allergenNames}, which conflicts with your saved restrictions.`,
      hasAllergenConflict: true,
      hasIncompleteData: false,
      scoreExplanation: 'A confirmed conflict with a profile allergen immediately caps the compatibility score at 0.',
    };
  }

  // If any item is unable to assess (e.g. missing nutrient or missing data)
  const unableItems = assessment.items.filter((i) => i.status === 'unable_to_assess');
  if (unableItems.length > 0 && assessment.items.every((i) => i.status === 'unable_to_assess')) {
    return {
      score: null,
      verdict: 'INCOMPLETE DATA',
      headlineReason: 'Key nutritional or ingredient facts are unavailable on the package label.',
      hasAllergenConflict: false,
      hasIncompleteData: true,
      scoreExplanation: 'Unable to calculate score because all active profile checks lack data.',
    };
  }

  // Calculate score based on cautious items and nutritional benchmarks
  let baseScore = 100;
  const cautionItems = assessment.items.filter((i) => i.status === 'caution');

  for (const item of cautionItems) {
    if (item.type === 'allergen') {
      baseScore -= 25;
    } else {
      baseScore -= 15;
    }
  }

  baseScore -= unableItems.length * 10;

  const finalScore = Math.max(10, Math.min(100, baseScore));

  if (cautionItems.length > 0) {
    const reasons = cautionItems.map((i) => i.headline).slice(0, 2).join('; ');
    return {
      score: finalScore,
      verdict: 'CAUTION',
      headlineReason: `${reasons}.`,
      hasAllergenConflict: false,
      hasIncompleteData: false,
      scoreExplanation: `Score started at 100 with deductions for ${cautionItems.length} advisory/nutrition caution(s).`,
    };
  }

  return {
    score: 100,
    verdict: 'NO IDENTIFIED CONFLICT',
    headlineReason: 'All available label data aligns with your active profile rules and dietary goals.',
    hasAllergenConflict: false,
    hasIncompleteData: false,
    scoreExplanation: '100/100 compatibility score: No allergen matches, advisory traces, or nutritional threshold concerns were found.',
  };
};

// Conservative, Evidenced-Based Assessment Engine
const evaluatePersonalizedAssessment = (
  product: ProductDetails,
  activePreferences: string[]
): PersonalizedAssessmentResult => {
  const items: AssessmentItem[] = [];

  const rawAi = product.rawAiData;

  // Determine source attribution text
  const sourceLabel =
    product.source === 'package_photo'
      ? 'Package Label AI'
      : product.source === 'merged'
      ? 'Package Label Photo & Database'
      : 'Open Food Facts Database';

  // Check if ingredients are available and readable
  const ingredientsMissing =
    !product.ingredients ||
    product.ingredients === 'Unavailable' ||
    product.ingredients.toLowerCase().includes('unavailable in open food facts') ||
    Boolean(product.missingGaps?.ingredientsMissing) ||
    rawAi?.extraction_limitations?.ingredients_panel_quality === 'not_provided' ||
    rawAi?.extraction_limitations?.ingredients_panel_quality === 'unreadable';

  const ingTextLower = (product.ingredients || '').toLowerCase();
  const declaredAllergensAi: string[] = Array.isArray(rawAi?.ingredients?.declared_allergens)
    ? rawAi.ingredients.declared_allergens
    : [];
  const precautionaryAi: string[] = Array.isArray(rawAi?.ingredients?.precautionary_statements)
    ? rawAi.ingredients.precautionary_statements
    : [];

  const declaredAllergensLower = [
    ...declaredAllergensAi.map((s: string) => s.toLowerCase()),
    (product.allergens || '').toLowerCase(),
  ].join(' ');

  const precautionaryLower = precautionaryAi.map((s: string) => s.toLowerCase()).join(' ');

  // Allergen Configurations & Conservative Derivative Keywords
  const allergenConfigs: Record<
    string,
    {
      displayName: string;
      keywords: string[];
      declaredPatterns: string[];
    }
  > = {
    gluten: {
      displayName: 'Gluten-Free',
      keywords: [
        'wheat',
        'gluten',
        'barley',
        'rye',
        'oats',
        'spelt',
        'kamut',
        'malt',
        'semolina',
        'couscous',
        'triticale',
        'wheat fibre',
        'wheat flour',
        'wheat starch',
      ],
      declaredPatterns: ['gluten', 'wheat', 'barley', 'rye', 'oats'],
    },
    peanuts: {
      displayName: 'Peanuts-Free',
      keywords: ['peanut', 'groundnut', 'arachis oil', 'peanut butter', 'peanut flour', 'peanut oil'],
      declaredPatterns: ['peanut', 'groundnut'],
    },
    'dairy / lactose': {
      displayName: 'Dairy / Lactose-Free',
      keywords: [
        'milk',
        'dairy',
        'lactose',
        'whey',
        'casein',
        'caseinate',
        'butter',
        'cream',
        'cheese',
        'yogurt',
        'curd',
        'ghee',
        'milk powder',
      ],
      declaredPatterns: ['milk', 'dairy', 'lactose', 'whey', 'butter'],
    },
    soy: {
      displayName: 'Soy-Free',
      keywords: [
        'soy',
        'soya',
        'soybean',
        'edamame',
        'tofu',
        'tempeh',
        'hydrolysed soy',
        'soy lecithin',
        'soy protein',
      ],
      declaredPatterns: ['soy', 'soya', 'soybean'],
    },
    shellfish: {
      displayName: 'Shellfish-Free',
      keywords: [
        'shellfish',
        'crustacean',
        'shrimp',
        'prawn',
        'crab',
        'lobster',
        'crawfish',
        'mollusc',
        'clam',
        'mussel',
        'oyster',
        'squid',
        'octopus',
      ],
      declaredPatterns: ['shellfish', 'crustacean', 'mollusc', 'shrimp', 'crab', 'lobster'],
    },
    eggs: {
      displayName: 'Eggs-Free',
      keywords: [
        'egg',
        'egg white',
        'egg yolk',
        'albumin',
        'ovalbumin',
        'globulin',
        'ovomucin',
        'ovomucoid',
        'lysozyme',
        'mayonnaise',
      ],
      declaredPatterns: ['egg', 'albumin', 'mayonnaise'],
    },
    'tree nuts': {
      displayName: 'Tree Nuts-Free',
      keywords: [
        'tree nut',
        'almond',
        'walnut',
        'cashew',
        'hazelnut',
        'pecan',
        'pistachio',
        'macadamia',
        'brazil nut',
        'chestnut',
        'praline',
      ],
      declaredPatterns: ['tree nut', 'almond', 'walnut', 'cashew', 'hazelnut', 'pecan', 'pistachio'],
    },
  };

  for (const pref of activePreferences) {
    const prefClean = pref
      .toLowerCase()
      .replace('-free', '')
      .trim();

    // Check if this matches an allergen restriction
    let matchedAllergenKey: string | null = null;
    for (const key of Object.keys(allergenConfigs)) {
      if (key === prefClean || prefClean.includes(key) || key.includes(prefClean)) {
        matchedAllergenKey = key;
        break;
      }
    }

    if (matchedAllergenKey) {
      const config = allergenConfigs[matchedAllergenKey];

      if (ingredientsMissing) {
        items.push({
          id: `allergen_${matchedAllergenKey}`,
          name: pref,
          type: 'allergen',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Ingredients Unavailable for Allergen Check',
          evidence:
            'Ingredients list has not been provided or is unreadable. Missing ingredients cannot be assumed allergen-free.',
          source: sourceLabel,
          guidanceNote:
            'Scan or photograph the packaging ingredients list to verify allergen presence.',
        });
        continue;
      }

      // Check 1: Explicitly Declared Allergens
      const matchedDeclared = config.declaredPatterns.filter((pattern) =>
        declaredAllergensLower.includes(pattern)
      );

      if (matchedDeclared.length > 0) {
        const declaredOnPackage = declaredAllergensAi.some((s) =>
          config.declaredPatterns.some((p) => s.toLowerCase().includes(p))
        );
        const itemSource = declaredOnPackage ? '📷 Package Label Photo' : sourceLabel;
        const dbHadNone = Boolean(
          product.rawOffData &&
            (!product.rawOffData.allergens_tags || product.rawOffData.allergens_tags.length === 0)
        );

        items.push({
          id: `allergen_${matchedAllergenKey}`,
          name: pref,
          type: 'allergen',
          status: 'avoid',
          statusLabel: 'Avoid / Conflict',
          headline: `Explicitly Declared Allergen: ${matchedDeclared.map((s) => s.toUpperCase()).join(', ')}`,
          evidence: `Packaging explicitly lists declared allergen matching your ${pref} profile: "${matchedDeclared.join(', ')}".`,
          source: itemSource,
          guidanceNote:
            'Severe allergy advisory: Avoid consumption. Declared on packaging.',
          conflictWarning:
            declaredOnPackage && dbHadNone
              ? 'Physical package declares this allergen (database had none). Package data takes precedence.'
              : undefined,
        });
        continue;
      }

      // Check 2: Ingredient-Based Keyword Scan
      const matchedIngredients = config.keywords.filter((kw) => {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        return regex.test(ingTextLower);
      });

      if (matchedIngredients.length > 0) {
        const foundInPackageText = Boolean(
          rawAi?.ingredients?.verbatim_visible_text &&
            config.keywords.some((kw) => {
              const regex = new RegExp(`\\b${kw}\\b`, 'i');
              return regex.test(rawAi.ingredients.verbatim_visible_text.toLowerCase());
            })
        );
        const itemSource = foundInPackageText ? '📷 Package Label Photo' : sourceLabel;

        items.push({
          id: `allergen_${matchedAllergenKey}`,
          name: pref,
          type: 'allergen',
          status: 'avoid',
          statusLabel: 'Avoid / Conflict',
          headline: `Ingredient-Based Allergen Match: ${matchedIngredients[0]}`,
          evidence: `Visible ingredients list contains matching ingredient: "${matchedIngredients.join(', ')}".`,
          source: itemSource,
          guidanceNote:
            'Potential allergen derivative detected in ingredient formulation.',
          conflictWarning: foundInPackageText
            ? 'Identified directly from packaging label photo, taking precedence over database.'
            : undefined,
        });
        continue;
      }

      // Check 3: Precautionary Statements ("May contain traces of...")
      const matchedPrecautionary = config.declaredPatterns.filter((pattern) =>
        precautionaryLower.includes(pattern)
      );

      if (matchedPrecautionary.length > 0) {
        const advisoryOnPackage = precautionaryAi.some((s) =>
          config.declaredPatterns.some((p) => s.toLowerCase().includes(p))
        );
        const itemSource = advisoryOnPackage ? '📷 Package Label Photo' : sourceLabel;

        items.push({
          id: `allergen_${matchedAllergenKey}`,
          name: pref,
          type: 'allergen',
          status: 'caution',
          statusLabel: 'Caution Advised',
          headline: 'Precautionary Cross-Contamination Statement',
          evidence: `Packaging label carries manufacturer advisory: "${precautionaryAi.join('; ')}".`,
          source: itemSource,
          guidanceNote:
            'Facility cross-contamination or line sharing advisory reported by manufacturer.',
        });
        continue;
      }

      // Check 4: No Identified Conflict
      items.push({
        id: `allergen_${matchedAllergenKey}`,
        name: pref,
        type: 'allergen',
        status: 'no_conflict',
        statusLabel: 'No Identified Conflict',
        headline: `No ${config.displayName} Conflict Identified`,
        evidence: `No declared ${matchedAllergenKey} or recognizable derivatives found in the visible label text.`,
        source: sourceLabel,
        guidanceNote:
          'Based solely on available visible text. Always inspect physical packaging.',
      });
      continue;
    }

    // NUTRITION GOALS EVALUATION
    if (pref === 'Low Sodium') {
      const sodiumFromAi = rawAi?.nutrition_facts?.sodium_g;
      const saltFromAi = rawAi?.nutrition_facts?.salt_g;
      const saltText = product.nutrients.salt;

      let sodiumGrams: number | null = null;
      let saltGrams: number | null = null;

      if (typeof sodiumFromAi === 'number') {
        sodiumGrams = sodiumFromAi;
      }
      if (typeof saltFromAi === 'number') {
        saltGrams = saltFromAi;
        if (sodiumGrams === null) sodiumGrams = saltGrams / 2.5;
      }

      if (sodiumGrams === null && saltText && saltText !== 'Unavailable') {
        const match = saltText.match(/([\d.]+)\s*g/i);
        if (match) {
          const val = parseFloat(match[1]);
          if (saltText.toLowerCase().includes('sodium')) {
            sodiumGrams = val;
          } else {
            saltGrams = val;
            sodiumGrams = val / 2.5;
          }
        }
      }

      if (sodiumGrams === null) {
        items.push({
          id: 'goal_low_sodium',
          name: pref,
          type: 'goal',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Sodium Quantity Not Listed',
          evidence: 'Neither sodium nor salt values were readable on the nutrition facts table.',
          source: sourceLabel,
          guidanceNote:
            'General guidance threshold cannot be checked without salt/sodium numbers.',
        });
      } else {
        const roundedSodium = Math.round(sodiumGrams * 1000) / 1000;
        const mgSodium = Math.round(sodiumGrams * 1000);

        if (roundedSodium > 0.6) {
          items.push({
            id: 'goal_low_sodium',
            name: pref,
            type: 'goal',
            status: 'caution',
            statusLabel: 'Caution Advised',
            headline: 'High Sodium Level',
            evidence: `Packaging lists ${roundedSodium}g sodium (~${mgSodium}mg) per 100g, exceeding the general low-sodium guideline of 0.12g (120mg).`,
            source: sourceLabel,
            guidanceNote:
              'Informational benchmark only; not clinical dietary advice.',
          });
        } else if (roundedSodium > 0.12) {
          items.push({
            id: 'goal_low_sodium',
            name: pref,
            type: 'goal',
            status: 'caution',
            statusLabel: 'Caution Advised',
            headline: 'Moderate Sodium Level',
            evidence: `Packaging lists ${roundedSodium}g sodium (~${mgSodium}mg) per 100g (benchmark low sodium is <= 0.12g / 120mg).`,
            source: sourceLabel,
            guidanceNote:
              'Informational benchmark only; not clinical dietary advice.',
          });
        } else {
          items.push({
            id: 'goal_low_sodium',
            name: pref,
            type: 'goal',
            status: 'no_conflict',
            statusLabel: 'No Identified Conflict',
            headline: 'Meets Low-Sodium Guideline',
            evidence: `Packaging lists ${roundedSodium}g sodium (~${mgSodium}mg) per 100g, within the low-sodium benchmark (<= 0.12g).`,
            source: sourceLabel,
            guidanceNote:
              'Informational benchmark only; not clinical dietary advice.',
          });
        }
      }
      continue;
    }

    if (pref === 'No Added Sugar') {
      const addedSugarKeywords = [
        'sugar',
        'dextrose',
        'maltodextrin',
        'glucose',
        'corn syrup',
        'high fructose',
        'invert sugar',
        'cane sugar',
        'molasses',
        'agave',
        'honey',
        'syrup',
        'sucrose',
      ];

      if (ingredientsMissing) {
        items.push({
          id: 'goal_no_added_sugar',
          name: pref,
          type: 'goal',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Ingredients Missing for Sugar Verification',
          evidence: 'Ingredients list is unavailable to verify presence of added sugars or syrups.',
          source: sourceLabel,
          guidanceNote:
            'Ingredients panel required to check for added sweeteners.',
        });
      } else {
        const foundSweeteners = addedSugarKeywords.filter((kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          return regex.test(ingTextLower);
        });

        if (foundSweeteners.length > 0) {
          items.push({
            id: 'goal_no_added_sugar',
            name: pref,
            type: 'goal',
            status: 'caution',
            statusLabel: 'Caution Advised',
            headline: 'Added Sweeteners Detected',
            evidence: `Ingredients list contains added sweeteners: "${foundSweeteners.join(', ')}". Total sugars: ${product.nutrients.sugars}.`,
            source: sourceLabel,
            guidanceNote:
              'Informational dietary flag. Added sugars can impact glycemic goals.',
          });
        } else {
          items.push({
            id: 'goal_no_added_sugar',
            name: pref,
            type: 'goal',
            status: 'no_conflict',
            statusLabel: 'No Identified Conflict',
            headline: 'No Added Sugars Identified',
            evidence: `No recognized added sugars or syrups found in visible ingredients (total sugars: ${product.nutrients.sugars}).`,
            source: sourceLabel,
            guidanceNote:
              'Based on visible ingredients list.',
          });
        }
      }
      continue;
    }

    if (pref === 'High Protein') {
      const proteinText = product.nutrients.protein;
      let proteinNum: number | null = null;
      if (typeof rawAi?.nutrition_facts?.protein_g === 'number') {
        proteinNum = rawAi.nutrition_facts.protein_g;
      } else if (proteinText && proteinText !== 'Unavailable') {
        const match = proteinText.match(/([\d.]+)\s*g/i);
        if (match) proteinNum = parseFloat(match[1]);
      }

      if (proteinNum === null) {
        items.push({
          id: 'goal_high_protein',
          name: pref,
          type: 'goal',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Protein Quantity Not Listed',
          evidence: 'Protein value is unavailable on the nutrition facts table.',
          source: sourceLabel,
        });
      } else if (proteinNum >= 10) {
        items.push({
          id: 'goal_high_protein',
          name: pref,
          type: 'goal',
          status: 'no_conflict',
          statusLabel: 'No Identified Conflict',
          headline: 'High Protein Content',
          evidence: `Contains ${proteinNum}g protein per 100g, meeting the high-protein benchmark (>= 10g/100g).`,
          source: sourceLabel,
        });
      } else {
        items.push({
          id: 'goal_high_protein',
          name: pref,
          type: 'goal',
          status: 'caution',
          statusLabel: 'Caution Advised',
          headline: 'Moderate / Low Protein',
          evidence: `Contains ${proteinNum}g protein per 100g (general high-protein benchmark is >= 10g/100g).`,
          source: sourceLabel,
        });
      }
      continue;
    }

    if (pref === 'Keto Friendly') {
      const carbsText = product.nutrients.carbs;
      let carbsNum: number | null = null;
      if (typeof rawAi?.nutrition_facts?.carbohydrates_g === 'number') {
        carbsNum = rawAi.nutrition_facts.carbohydrates_g;
      } else if (carbsText && carbsText !== 'Unavailable') {
        const match = carbsText.match(/([\d.]+)\s*g/i);
        if (match) carbsNum = parseFloat(match[1]);
      }

      if (carbsNum === null) {
        items.push({
          id: 'goal_keto',
          name: pref,
          type: 'goal',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Carbohydrates Value Not Listed',
          evidence: 'Carbohydrates quantity is unavailable on the nutrition facts table.',
          source: sourceLabel,
        });
      } else if (carbsNum > 10) {
        items.push({
          id: 'goal_keto',
          name: pref,
          type: 'goal',
          status: 'caution',
          statusLabel: 'Caution Advised',
          headline: 'Higher Carbohydrate Content',
          evidence: `Packaging lists ${carbsNum}g carbohydrates per 100g, exceeding the typical keto threshold of <= 10g.`,
          source: sourceLabel,
          guidanceNote:
            'Informational benchmark; check serving size and personal carb limits.',
        });
      } else {
        items.push({
          id: 'goal_keto',
          name: pref,
          type: 'goal',
          status: 'no_conflict',
          statusLabel: 'No Identified Conflict',
          headline: 'Low Carbohydrate Level',
          evidence: `Packaging lists ${carbsNum}g carbohydrates per 100g, consistent with keto guidelines.`,
          source: sourceLabel,
        });
      }
      continue;
    }

    if (pref === 'Vegan') {
      const nonVeganKeywords = [
        'milk',
        'dairy',
        'whey',
        'casein',
        'cheese',
        'butter',
        'egg',
        'honey',
        'gelatin',
        'carmine',
        'cochineal',
        'shellac',
        'lard',
        'meat',
        'beef',
        'chicken',
        'pork',
        'fish',
        'tallow',
        'collagen',
      ];

      if (ingredientsMissing) {
        items.push({
          id: 'goal_vegan',
          name: pref,
          type: 'goal',
          status: 'unable_to_assess',
          statusLabel: 'Unable to Assess',
          headline: 'Ingredients Missing for Vegan Assessment',
          evidence: 'Ingredients list is unavailable to verify presence of animal-derived products.',
          source: sourceLabel,
        });
      } else {
        const foundAnimal = nonVeganKeywords.filter((kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          return regex.test(ingTextLower);
        });

        if (foundAnimal.length > 0) {
          items.push({
            id: 'goal_vegan',
            name: pref,
            type: 'goal',
            status: 'avoid',
            statusLabel: 'Avoid / Conflict',
            headline: 'Animal-Derived Ingredients Detected',
            evidence: `Visible ingredients list contains animal derivative: "${foundAnimal.join(', ')}".`,
            source: sourceLabel,
          });
        } else {
          items.push({
            id: 'goal_vegan',
            name: pref,
            type: 'goal',
            status: 'no_conflict',
            statusLabel: 'No Identified Conflict',
            headline: 'No Animal Derivatives Identified',
            evidence: 'No common animal-derived ingredients identified in visible ingredients list.',
            source: sourceLabel,
          });
        }
      }
      continue;
    }

    if (pref === 'Organic Only') {
      const isOrganic =
        product.name.toLowerCase().includes('organic') ||
        product.brand.toLowerCase().includes('organic') ||
        ingTextLower.includes('organic');

      if (isOrganic) {
        items.push({
          id: 'goal_organic',
          name: pref,
          type: 'goal',
          status: 'no_conflict',
          statusLabel: 'No Identified Conflict',
          headline: 'Organic Indication Found',
          evidence: 'Product name or ingredients explicitly state organic origin.',
          source: sourceLabel,
        });
      } else {
        items.push({
          id: 'goal_organic',
          name: pref,
          type: 'goal',
          status: 'caution',
          statusLabel: 'Caution Advised',
          headline: 'No Organic Claim Found',
          evidence: 'Visible text does not indicate certified organic claims.',
          source: sourceLabel,
        });
      }
      continue;
    }
  }

  // Calculate Overall Status
  let overallStatus: AssessmentStatus = 'no_conflict';
  let overallTitle = 'No Identified Conflicts in Available Information';
  let overallSummary =
    'No direct allergen conflicts or dietary threshold breaches detected based on your active profile and currently available label data.';

  if (items.some((i) => i.status === 'avoid')) {
    overallStatus = 'avoid';
    overallTitle = 'Avoid / Potential Allergen Conflict';
    overallSummary =
      'One or more ingredients or declared statements conflict with your saved allergy or dietary restrictions.';
  } else if (items.some((i) => i.status === 'caution')) {
    overallStatus = 'caution';
    overallTitle = 'Caution Advised';
    overallSummary =
      'Advisory warnings, precautionary traces, or nutritional threshold differences found for your profile.';
  } else if (items.some((i) => i.status === 'unable_to_assess') || ingredientsMissing) {
    overallStatus = 'unable_to_assess';
    overallTitle = 'Incomplete Information to Assess';
    overallSummary =
      'Some required ingredient or nutritional facts could not be verified from available data.';
  }

  return {
    overallStatus,
    overallTitle,
    overallSummary,
    items,
    missingIngredients: ingredientsMissing,
  };
};

// Open Food Facts v3 Parser
const parseProductFromOFF = (barcode: string, raw: any): ProductDetails => {
  const p = raw?.product || {};
  const n = p?.nutriments || {};

  const formatNutrient = (val: any, unit: string = 'g'): string => {
    if (val === undefined || val === null || val === '') return 'Unavailable';
    const num = Number(val);
    if (isNaN(num)) return `${val}${unit ? ' ' + unit : ''}`;
    return `${Math.round(num * 10) / 10}${unit}`;
  };

  const caloriesVal = n['energy-kcal_100g'] ?? n['energy-kcal'] ?? n['energy-kcal_value'];
  const calories =
    caloriesVal !== undefined && caloriesVal !== null && caloriesVal !== ''
      ? `${Math.round(Number(caloriesVal))} kcal`
      : 'Unavailable';

  const allergensList: string[] = [];
  if (Array.isArray(p.allergens_tags) && p.allergens_tags.length > 0) {
    p.allergens_tags.forEach((tag: string) => {
      const clean = tag.replace(/^[a-z]{2}:/, '').trim();
      if (clean) allergensList.push(clean);
    });
  } else if (typeof p.allergens === 'string' && p.allergens.trim()) {
    allergensList.push(p.allergens.trim());
  }

  const allergens = allergensList.length > 0 ? allergensList.join(', ') : 'None reported in database';

  const brand =
    p.brands?.trim() ||
    (Array.isArray(p.brands_tags) && p.brands_tags.length > 0 ? p.brands_tags.join(', ') : null) ||
    'Unavailable';

  const name =
    p.product_name?.trim() ||
    p.product_name_en?.trim() ||
    p.generic_name?.trim() ||
    'Unavailable';

  const packageSize = p.quantity?.trim() || p.serving_size?.trim() || 'Unavailable';

  const ingredients =
    p.ingredients_text?.trim() ||
    p.ingredients_text_en?.trim() ||
    'Unavailable in Open Food Facts database';

  const nutriScore =
    typeof p.nutriscore_grade === 'string' && p.nutriscore_grade.length > 0
      ? p.nutriscore_grade.toUpperCase()
      : null;

  const novaGroup =
    typeof p.nova_group === 'number'
      ? p.nova_group
      : typeof n['nova-group_100g'] === 'number'
      ? n['nova-group_100g']
      : null;

  const imageUrl = p.image_front_url || p.image_url || p.image_small_url || null;
  const servingSize = p.serving_size?.trim() || null;

  const fatVal = formatNutrient(n['fat_100g'] ?? n['fat']);
  const carbsVal = formatNutrient(n['carbohydrates_100g'] ?? n['carbohydrates']);
  const proteinVal = formatNutrient(n['proteins_100g'] ?? n['proteins']);

  const ingredientsMissing =
    !ingredients ||
    ingredients === 'Unavailable' ||
    ingredients.toLowerCase().includes('unavailable in open food facts');

  const nutritionMissing =
    calories === 'Unavailable' ||
    fatVal === 'Unavailable' ||
    carbsVal === 'Unavailable' ||
    proteinVal === 'Unavailable';

  return {
    barcode,
    name,
    brand,
    packageSize,
    ingredients,
    allergens,
    nutriScore,
    novaGroup,
    imageUrl,
    servingSize,
    nutrients: {
      calories,
      fat: fatVal,
      saturatedFat: formatNutrient(n['saturated-fat_100g'] ?? n['saturated-fat']),
      carbs: carbsVal,
      sugars: formatNutrient(n['sugars_100g'] ?? n['sugars']),
      fiber: formatNutrient(n['fiber_100g'] ?? n['fiber']),
      protein: proteinVal,
      salt: formatNutrient(
        n['salt_100g'] ?? n['salt'] ?? (n['sodium_100g'] !== undefined ? `${n['sodium_100g']}g sodium` : undefined)
      ),
    },
    source: 'open_food_facts',
    rawOffData: p,
    missingGaps: {
      ingredientsMissing,
      nutritionMissing,
    },
  };
};

const parseGramValue = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const match = text.match(/([\d.]+)\s*(?:g\b|grams?\b)/i);
  if (match) {
    const val = parseFloat(match[1]);
    return !isNaN(val) && val > 0 ? val : null;
  }
  return null;
};

const formatScaledNutrient = (
  rawStr: string | undefined | null,
  scale: number,
  unit: string = 'g'
): string => {
  if (!rawStr || rawStr === 'Unavailable' || rawStr === 'None') return 'Unavailable';
  const numMatch = rawStr.match(/([\d.]+)/);
  if (!numMatch) return rawStr;
  const num = parseFloat(numMatch[1]);
  if (isNaN(num)) return rawStr;
  const scaled = Math.round(num * scale * 10) / 10;
  if (rawStr.toLowerCase().includes('kcal')) {
    return `${Math.round(num * scale)} kcal`;
  }
  return `${scaled}${unit}`;
};

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
  const [scanMode, setScanMode] = useState<ScanMode>('barcode');
  const [activePreferences, setActivePreferences] = useState<string[]>([
    'Gluten-Free',
    'Low Sodium',
    'No Added Sugar',
  ]);

  // Dedicated Results & Details State
  const [nutritionBasis, setNutritionBasis] = useState<'100g' | 'serving' | 'pack'>('100g');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    verdict: true,
    allergens: false,
    nutrition: false,
    ingredients: false,
    sources: false,
    disclaimer: false,
  });
  const [infoModalContent, setInfoModalContent] = useState<{ title: string; text: string } | null>(null);

  const toggleSection = (sectionKey: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [sectionKey]: !prev[sectionKey],
    }));
  };

  // Hardware Camera & Image State
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannedBarcode, setScannedBarcode] = useState<ScannedBarcode | null>(null);
  const [isScanningActive, setIsScanningActive] = useState<boolean>(true);
  const [torchEnabled, setTorchEnabled] = useState<boolean>(false);

  // Separate Label Photos (Ingredients and Nutrition Table)
  const [ingredientsPhoto, setIngredientsPhoto] = useState<LabelPhoto | null>(null);
  const [nutritionPhoto, setNutritionPhoto] = useState<LabelPhoto | null>(null);

  // Open Food Facts API v3 State
  const [isLoadingProduct, setIsLoadingProduct] = useState<boolean>(false);
  const [productData, setProductData] = useState<ProductDetails | null>(null);
  const [productNotFound, setProductNotFound] = useState<boolean>(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Gemini AI Analysis State
  const [isAnalyzingAi, setIsAnalyzingAi] = useState<boolean>(false);
  const [aiAnalysisError, setAiAnalysisError] = useState<string | null>(null);
  const [aiSuccessMessage, setAiSuccessMessage] = useState<string | null>(null);

  // Preference Toggle
  const togglePreference = (pref: string) => {
    setActivePreferences((prev) =>
      prev.includes(pref) ? prev.filter((p) => p !== pref) : [...prev, pref]
    );
  };

  // Real Barcode Detection Handler
  const handleBarcodeScanned = (result: BarcodeScanningResult) => {
    if (!isScanningActive || isLoadingProduct) return;
    setIsScanningActive(false);

    const barcodeStr = result.data?.trim();
    const timeString = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    setScannedBarcode({
      data: barcodeStr,
      type: result.type,
      scannedAt: timeString,
    });

    if (barcodeStr) {
      lookupProduct(barcodeStr);
    }
  };

  // Real Open Food Facts v3 Lookup
  const lookupProduct = async (barcode: string) => {
    setIsLoadingProduct(true);
    setProductData(null);
    setProductNotFound(false);
    setLookupError(null);
    setIngredientsPhoto(null);
    setNutritionPhoto(null);
    setAiAnalysisError(null);
    setAiSuccessMessage(null);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(
        `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json`,
        {
          headers: {
            'User-Agent': 'NutriLens - Android - Version 1.0 - contact@nutrilens.app',
            Accept: 'application/json',
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (response.status === 404) {
        setProductNotFound(true);
        return;
      }

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const json = await response.json();

      if (
        json.status === 'failure' ||
        json.result?.id === 'product_not_found' ||
        !json.product
      ) {
        setProductNotFound(true);
        return;
      }

      const parsed = parseProductFromOFF(barcode, json);
      setProductData(parsed);
      setCurrentScreen('result');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setLookupError('Request timed out. Please check your internet connection.');
      } else {
        setLookupError(err?.message || 'Could not connect to Open Food Facts database.');
      }
    } finally {
      setIsLoadingProduct(false);
    }
  };

  const resetBarcodeScanner = () => {
    setScannedBarcode(null);
    setProductData(null);
    setProductNotFound(false);
    setLookupError(null);
    setIsLoadingProduct(false);
    setIsScanningActive(true);
    setIngredientsPhoto(null);
    setNutritionPhoto(null);
    setAiAnalysisError(null);
    setAiSuccessMessage(null);
  };

  // Capture Photo with Camera (Ingredients or Nutrition)
  const capturePhoto = async (target: 'ingredients' | 'nutrition') => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Camera Access Needed',
          'NutriLens needs camera access so you can photograph food labels and nutrition tables.'
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const photo: LabelPhoto = {
          uri: asset.uri,
          base64: asset.base64 || undefined,
          mimeType: asset.mimeType || 'image/jpeg',
        };
        if (target === 'ingredients') {
          setIngredientsPhoto(photo);
        } else {
          setNutritionPhoto(photo);
        }
        setAiAnalysisError(null);
      }
    } catch (error: any) {
      Alert.alert('Camera Error', error?.message || 'Could not launch camera.');
    }
  };

  // Pick Photo from Gallery (Ingredients or Nutrition)
  const pickPhotoFromGallery = async (target: 'ingredients' | 'nutrition') => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Gallery Access Needed',
          'NutriLens needs permission to access your photo library so you can select label photos.'
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const photo: LabelPhoto = {
          uri: asset.uri,
          base64: asset.base64 || undefined,
          mimeType: asset.mimeType || 'image/jpeg',
        };
        if (target === 'ingredients') {
          setIngredientsPhoto(photo);
        } else {
          setNutritionPhoto(photo);
        }
        setAiAnalysisError(null);
      }
    } catch (error: any) {
      Alert.alert('Gallery Error', error?.message || 'Could not open photo gallery.');
    }
  };

  // Multi-Image Gemini AI Analysis
  const analyzeLabelsWithGemini = async () => {
    if (!ingredientsPhoto && !nutritionPhoto) {
      Alert.alert('No Photos', 'Please capture or upload at least one label photo before analyzing.');
      return;
    }

    setIsAnalyzingAi(true);
    setAiAnalysisError(null);
    setAiSuccessMessage(null);

    try {
      const payload: any = {};
      if (ingredientsPhoto?.base64) {
        payload.ingredientsImage = {
          base64: ingredientsPhoto.base64,
          mimeType: ingredientsPhoto.mimeType || 'image/jpeg',
        };
      }
      if (nutritionPhoto?.base64) {
        payload.nutritionImage = {
          base64: nutritionPhoto.base64,
          mimeType: nutritionPhoto.mimeType || 'image/jpeg',
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000);

      const response = await fetch(`${BACKEND_URL}/api/analyze-label`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok || !data.success) {
        const errorMsg = data.error || `Server responded with status ${response.status}`;
        setAiAnalysisError(errorMsg);
        // Photos are preserved so the user can easily retry!
        return;
      }

      // Merge AI extraction into productData and display
      mergeAiExtractionIntoProduct(data);
      setAiSuccessMessage('Packaging analyzed successfully with Gemini AI!');
      setCurrentScreen('result');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setAiAnalysisError('Request timed out. Please check that your PC backend server is running on port 5000.');
      } else {
        setAiAnalysisError(
          err.message || `Could not connect to NutriLens backend server at ${BACKEND_URL}. Check Wi-Fi connection.`
        );
      }
    } finally {
      setIsAnalyzingAi(false);
    }
  };

  // Merge AI extraction results with any existing Open Food Facts record
  const mergeAiExtractionIntoProduct = (aiData: any) => {
    const p = aiData.product || {};
    const ing = aiData.ingredients || {};
    const nut = aiData.nutrition_facts || {};

    const formatAiNutrient = (val: number | null | undefined, unit: string = 'g'): string => {
      if (val === null || val === undefined) return 'Unavailable';
      return `${val}${unit}`;
    };

    setProductData((existing) => {
      const conflicts: ConflictItem[] = [];

      const resolveValue = (field: string, offVal: string | undefined, aiVal: string | null | undefined): string => {
        if (!aiVal || aiVal === 'Unavailable') {
          return offVal && offVal !== 'Unavailable' ? offVal : 'Unavailable';
        }
        if (offVal && offVal !== 'Unavailable' && offVal.toLowerCase() !== aiVal.toLowerCase()) {
          conflicts.push({
            field,
            databaseValue: offVal,
            packagingValue: aiVal,
          });
        }
        return aiVal;
      };

      const newCalories = resolveValue(
        'Calories',
        existing?.nutrients.calories,
        nut.energy_kcal !== null && nut.energy_kcal !== undefined ? `${nut.energy_kcal} kcal` : null
      );
      const newFat = resolveValue('Total Fat', existing?.nutrients.fat, formatAiNutrient(nut.fat_g));
      const newSatFat = resolveValue('Saturated Fat', existing?.nutrients.saturatedFat, formatAiNutrient(nut.saturated_fat_g));
      const newCarbs = resolveValue('Carbohydrates', existing?.nutrients.carbs, formatAiNutrient(nut.carbohydrates_g));
      const newSugars = resolveValue('Sugars', existing?.nutrients.sugars, formatAiNutrient(nut.sugars_g));
      const newFiber = resolveValue('Dietary Fiber', existing?.nutrients.fiber, formatAiNutrient(nut.fiber_g));
      const newProtein = resolveValue('Protein', existing?.nutrients.protein, formatAiNutrient(nut.protein_g));
      const newSalt = resolveValue(
        'Salt',
        existing?.nutrients.salt,
        nut.salt_g !== null && nut.salt_g !== undefined ? `${nut.salt_g}g` : formatAiNutrient(nut.sodium_g, 'g sodium')
      );

      const newIngredients = resolveValue('Ingredients', existing?.ingredients, ing.verbatim_visible_text || null);

      const allergensList: string[] = [];
      if (Array.isArray(ing.declared_allergens) && ing.declared_allergens.length > 0) {
        allergensList.push(...ing.declared_allergens);
      }
      if (Array.isArray(ing.precautionary_statements) && ing.precautionary_statements.length > 0) {
        allergensList.push(...ing.precautionary_statements.map((s: string) => `[Advisory: ${s}]`));
      }
      const newAllergens =
        allergensList.length > 0
          ? allergensList.join(', ')
          : existing?.allergens || 'None declared on visible packaging';

      // Record allergen conflicts between packaging and database
      if (allergensList.length > 0) {
        const pkgAllergens = allergensList.join(', ');
        if (
          existing?.allergens &&
          existing.allergens !== 'Unavailable' &&
          existing.allergens.toLowerCase() !== pkgAllergens.toLowerCase()
        ) {
          conflicts.push({
            field: 'Declared Allergens',
            databaseValue: existing.allergens,
            packagingValue: pkgAllergens,
          });
        }
      }

      const newNutriScore = p.nutriscore_printed_on_pack ? p.nutriscore_printed_on_pack.toUpperCase() : existing?.nutriScore || null;
      const newNova = p.nova_printed_on_pack !== null ? p.nova_printed_on_pack : existing?.novaGroup || null;

      const mergedProduct: ProductDetails = {
        barcode: existing?.barcode || scannedBarcode?.data || 'PHOTO-SCAN',
        name: resolveValue('Product Name', existing?.name, p.product_name),
        brand: resolveValue('Brand', existing?.brand, p.brand),
        packageSize: resolveValue('Quantity', existing?.packageSize, p.package_quantity),
        ingredients: newIngredients,
        allergens: newAllergens,
        nutriScore: newNutriScore,
        novaGroup: newNova,
        imageUrl: existing?.imageUrl || ingredientsPhoto?.uri || nutritionPhoto?.uri || null,
        servingSize: nut.basis || p.serving_size || existing?.servingSize || null,
        nutrients: {
          calories: newCalories,
          fat: newFat,
          saturatedFat: newSatFat,
          carbs: newCarbs,
          sugars: newSugars,
          fiber: newFiber,
          protein: newProtein,
          salt: newSalt,
        },
        source: existing ? 'merged' : 'package_photo',
        rawOffData: existing?.rawOffData || null,
        rawAiData: aiData,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        missingGaps: {
          ingredientsMissing: !newIngredients || newIngredients === 'Unavailable',
          nutritionMissing: newCalories === 'Unavailable' && newFat === 'Unavailable',
        },
      };

      return mergedProduct;
    });

    setProductNotFound(false);
    setCurrentScreen('result');
  };

  // --- SCREEN 1: DEDICATED SCAN HUB SCREEN ---
  const renderScanScreen = () => (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Top Navigation */}
      <View style={styles.screenHeader}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            setIsScanningActive(false);
            setCurrentScreen('home');
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>← Home</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Scan Food</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Mode Selector Tabs */}
      <View style={styles.modeTabsContainer}>
        <TouchableOpacity
          style={[styles.modeTab, scanMode === 'barcode' && styles.modeTabActive]}
          onPress={() => {
            setScanMode('barcode');
            setIsScanningActive(true);
          }}
          activeOpacity={0.8}
        >
          <Text style={[styles.modeTabText, scanMode === 'barcode' && styles.modeTabTextActive]}>
            Scan Barcode
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.modeTab, scanMode === 'label' && styles.modeTabActive]}
          onPress={() => {
            setScanMode('label');
            setIsScanningActive(false);
          }}
          activeOpacity={0.8}
        >
          <Text style={[styles.modeTabText, scanMode === 'label' && styles.modeTabTextActive]}>
            Take Label Photo
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.modeTab, scanMode === 'gallery' && styles.modeTabActive]}
          onPress={() => {
            setScanMode('gallery');
            setIsScanningActive(false);
          }}
          activeOpacity={0.8}
        >
          <Text style={[styles.modeTabText, scanMode === 'gallery' && styles.modeTabTextActive]}>
            From Gallery
          </Text>
        </TouchableOpacity>
      </View>

      {/* MODE 1: REAL LIVE BARCODE SCANNER */}
      {scanMode === 'barcode' && (
        <View>
          {!cameraPermission?.granted ? (
            <View style={styles.permissionCard}>
              <Text style={styles.permissionIcon}>📷</Text>
              <Text style={styles.permissionTitle}>Camera Permission Required</Text>
              <Text style={styles.permissionDesc}>
                {"NutriLens scans physical barcodes in real time using your phone's camera."}
              </Text>
              <TouchableOpacity
                style={styles.primaryScanButton}
                onPress={async () => {
                  const res = await requestCameraPermission();
                  if (res && res.granted) {
                    setIsScanningActive(true);
                  }
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryScanButtonText}>Grant Camera Access</Text>
              </TouchableOpacity>
            </View>
          ) : isLoadingProduct ? (
            /* Loading State */
            <View style={styles.loadingCard}>
              <View style={styles.loadingSpinnerContainer}>
                <ActivityIndicator size="large" color="#A855F7" />
              </View>
              <Text style={styles.loadingTitle}>Looking Up Food Item...</Text>
              <Text style={styles.loadingSubtitle}>
                Querying Open Food Facts v3 database for ingredients and nutrition
              </Text>
              {scannedBarcode && (
                <View style={styles.loadingBarcodeTag}>
                  <Text style={styles.loadingBarcodeLabel}>Barcode:</Text>
                  <Text style={styles.loadingBarcodeValue}>{scannedBarcode.data}</Text>
                </View>
              )}
            </View>
          ) : productNotFound ? (
            /* Product Not Found State with 4-Action Missing Label Fallback */
            <View style={styles.notFoundCard}>
              <View style={styles.notFoundIconCircle}>
                <Text style={styles.notFoundIcon}>🔍</Text>
              </View>
              <Text style={styles.notFoundTitle}>Product Not Found</Text>
              {scannedBarcode && (
                <View style={styles.notFoundBarcodeBadge}>
                  <Text style={styles.notFoundBarcodeText}>{scannedBarcode.data}</Text>
                </View>
              )}
              <Text style={styles.notFoundDesc}>
                Product not found in our database. You can still analyse it by scanning the package labels.
              </Text>

              {/* ACTION MODULE 1: INGREDIENTS LIST */}
              <View style={styles.captureModuleCard}>
                <View style={styles.captureModuleHeader}>
                  <Text style={styles.captureModuleIcon}>🌿</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.captureModuleTitle}>Ingredients List</Text>
                    <Text style={styles.captureModuleSub}>Used to verify allergens & additives</Text>
                  </View>
                  {ingredientsPhoto && (
                    <View style={styles.photoReadyBadge}>
                      <Text style={styles.photoReadyBadgeText}>✓ Attached</Text>
                    </View>
                  )}
                </View>

                {ingredientsPhoto ? (
                  <View style={styles.thumbnailRow}>
                    <Image source={{ uri: ingredientsPhoto.uri }} style={styles.miniThumbnail} />
                    <View style={styles.thumbnailActionCol}>
                      <TouchableOpacity
                        style={styles.thumbnailBtn}
                        onPress={() => capturePhoto('ingredients')}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.thumbnailBtnText}>📷 Retake</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                        onPress={() => setIngredientsPhoto(null)}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.dualActionButtonRow}>
                    <TouchableOpacity
                      style={styles.moduleActionButton}
                      onPress={() => capturePhoto('ingredients')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.moduleActionBtnIcon}>📷</Text>
                      <Text style={styles.moduleActionBtnText}>Take Ingredients Photo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.moduleActionButton, { backgroundColor: '#1A1333', borderColor: '#3F226D' }]}
                      onPress={() => pickPhotoFromGallery('ingredients')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.moduleActionBtnIcon}>🖼️</Text>
                      <Text style={styles.moduleActionBtnText}>Upload Ingredients</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* ACTION MODULE 2: NUTRITION FACTS TABLE */}
              <View style={styles.captureModuleCard}>
                <View style={styles.captureModuleHeader}>
                  <Text style={styles.captureModuleIcon}>📊</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.captureModuleTitle}>Nutrition Facts Table</Text>
                    <Text style={styles.captureModuleSub}>Used for calories, fats, carbs & protein</Text>
                  </View>
                  {nutritionPhoto && (
                    <View style={styles.photoReadyBadge}>
                      <Text style={styles.photoReadyBadgeText}>✓ Attached</Text>
                    </View>
                  )}
                </View>

                {nutritionPhoto ? (
                  <View style={styles.thumbnailRow}>
                    <Image source={{ uri: nutritionPhoto.uri }} style={styles.miniThumbnail} />
                    <View style={styles.thumbnailActionCol}>
                      <TouchableOpacity
                        style={styles.thumbnailBtn}
                        onPress={() => capturePhoto('nutrition')}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.thumbnailBtnText}>📷 Retake</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                        onPress={() => setNutritionPhoto(null)}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.dualActionButtonRow}>
                    <TouchableOpacity
                      style={styles.moduleActionButton}
                      onPress={() => capturePhoto('nutrition')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.moduleActionBtnIcon}>📷</Text>
                      <Text style={styles.moduleActionBtnText}>Take Nutrition Photo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.moduleActionButton, { backgroundColor: '#1A1333', borderColor: '#3F226D' }]}
                      onPress={() => pickPhotoFromGallery('nutrition')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.moduleActionBtnIcon}>🖼️</Text>
                      <Text style={styles.moduleActionBtnText}>Upload Nutrition Table</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* AI ANALYSIS TRIGGER BUTTON */}
              {(ingredientsPhoto || nutritionPhoto) && (
                <View style={{ width: '100%', marginTop: 8 }}>
                  <TouchableOpacity
                    style={[styles.primaryScanButton, isAnalyzingAi && { opacity: 0.7 }]}
                    onPress={analyzeLabelsWithGemini}
                    disabled={isAnalyzingAi}
                    activeOpacity={0.85}
                  >
                    {isAnalyzingAi ? (
                      <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 10 }} />
                    ) : (
                      <Text style={styles.primaryScanIcon}>✨</Text>
                    )}
                    <View style={styles.primaryScanTextContainer}>
                      <Text style={styles.primaryScanButtonText}>
                        {isAnalyzingAi ? 'Analyzing Labels...' : 'Analyse Package Labels with Gemini AI'}
                      </Text>
                      <Text style={styles.primaryScanSubtext}>
                        {ingredientsPhoto && nutritionPhoto
                          ? 'Analyzing both ingredients & nutrition table'
                          : ingredientsPhoto
                          ? 'Analyzing ingredients list (nutrition marked not provided)'
                          : 'Analyzing nutrition table (ingredients marked not provided)'}
                      </Text>
                    </View>
                    {!isAnalyzingAi && <Text style={styles.arrowIcon}>→</Text>}
                  </TouchableOpacity>
                </View>
              )}

              {/* AI ANALYSIS ERROR CALLOUT (IF FAILED / UNCONFIGURED KEY) */}
              {aiAnalysisError && (
                <View style={styles.aiErrorBanner}>
                  <Text style={styles.aiErrorIcon}>⚠️</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.aiErrorTitle}>Analysis Notice</Text>
                    <Text style={styles.aiErrorDesc}>{aiAnalysisError}</Text>
                    <Text style={styles.aiErrorHint}>
                      Your photos are preserved above so you can easily retry.
                    </Text>
                    <TouchableOpacity
                      style={styles.retryAiBtn}
                      onPress={analyzeLabelsWithGemini}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.retryAiBtnText}>🔄 Retry Analysis</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <TouchableOpacity
                style={styles.secondaryScanButton}
                onPress={resetBarcodeScanner}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryScanButtonText}>⚡ Scan Another Barcode</Text>
              </TouchableOpacity>
            </View>
          ) : lookupError ? (
            /* Network / Lookup Error State */
            <View style={styles.notFoundCard}>
              <View style={[styles.notFoundIconCircle, { backgroundColor: '#3B1525', borderColor: '#EF4444' }]}>
                <Text style={styles.notFoundIcon}>⚠️</Text>
              </View>
              <Text style={styles.notFoundTitle}>Lookup Failed</Text>
              <Text style={styles.notFoundDesc}>{lookupError}</Text>

              {scannedBarcode && (
                <TouchableOpacity
                  style={styles.primaryScanButton}
                  onPress={() => lookupProduct(scannedBarcode.data)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryScanIcon}>🔄</Text>
                  <View style={styles.primaryScanTextContainer}>
                    <Text style={styles.primaryScanButtonText}>Retry Lookup</Text>
                    <Text style={styles.primaryScanSubtext}>Re-query Open Food Facts</Text>
                  </View>
                  <Text style={styles.arrowIcon}>→</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.secondaryScanButton}
                onPress={resetBarcodeScanner}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryScanButtonText}>⚡ Scan Another Barcode</Text>
              </TouchableOpacity>
            </View>
          ) : productData ? (
            /* Active Scanned Product Status Card */
            <View style={styles.productCard}>
              <View style={styles.sourceTagRow}>
                {aiSuccessMessage && (
                  <View style={[styles.sourceBadge, { backgroundColor: '#064E3B', borderColor: '#10B981', marginBottom: 8 }]}>
                    <Text style={[styles.sourceBadgeText, { color: '#6EE7B7' }]}>✓ {aiSuccessMessage}</Text>
                  </View>
                )}
                {productData.source === 'merged' ? (
                  <View style={[styles.sourceBadge, { backgroundColor: '#31104D', borderColor: '#9333EA' }]}>
                    <Text style={styles.sourceBadgeText}>⚡ SOURCE: MERGED (DATABASE + PACKAGE PHOTO)</Text>
                  </View>
                ) : productData.source === 'package_photo' ? (
                  <View style={[styles.sourceBadge, { backgroundColor: '#1E1B4B', borderColor: '#6366F1' }]}>
                    <Text style={styles.sourceBadgeText}>📷 SOURCE: PACKAGE LABEL AI EXTRACTION</Text>
                  </View>
                ) : (
                  <View style={[styles.sourceBadge, { backgroundColor: '#132A3E', borderColor: '#0284C7' }]}>
                    <Text style={styles.sourceBadgeText}>🌐 SOURCE: OPEN FOOD FACTS DATABASE</Text>
                  </View>
                )}
              </View>

              <Text style={styles.productName}>{productData.name}</Text>
              <Text style={styles.recentItemBrand}>
                {productData.brand} • {productData.packageSize}
              </Text>

              {/* Conflict indicator if any */}
              {productData.conflicts && productData.conflicts.length > 0 && (
                <View style={[styles.overviewConflictBanner, { marginVertical: 10 }]}>
                  <Text style={styles.overviewConflictIcon}>⚡</Text>
                  <Text style={styles.overviewConflictText}>
                    {`${productData.conflicts.length} packaging difference(s) detected. Package values take precedence.`}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryScanButton, { marginTop: 12 }]}
                onPress={() => setCurrentScreen('result')}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryScanIcon}>✨</Text>
                <View style={styles.primaryScanTextContainer}>
                  <Text style={styles.primaryScanButtonText}>View Result Overview</Text>
                  <Text style={styles.primaryScanSubtext}>Compatibility score, allergen status & quick-strip</Text>
                </View>
                <Text style={styles.arrowIcon}>→</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryScanButton}
                onPress={resetBarcodeScanner}
                activeOpacity={0.8}
              >
                <Text style={styles.secondaryScanButtonText}>⚡ Scan Another Food Product</Text>
              </TouchableOpacity>
            </View>
          ) : scannedBarcode ? (
            /* Barcode captured fallback */
            <View style={styles.resultCard}>
              <View style={styles.resultBadge}>
                <Text style={styles.resultBadgeText}>BARCODE CAPTURED</Text>
              </View>
              <Text style={styles.barcodeData}>{scannedBarcode.data}</Text>
              <TouchableOpacity
                style={styles.primaryScanButton}
                onPress={() => lookupProduct(scannedBarcode.data)}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryScanButtonText}>⚡ Query Open Food Facts</Text>
              </TouchableOpacity>
            </View>
          ) : (
            /* Live Camera Feed without children (prevents crash and warnings) */
            <View style={styles.liveCameraContainer}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                enableTorch={torchEnabled}
                barcodeScannerSettings={{
                  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'qr', 'code128', 'code39'],
                }}
                onBarcodeScanned={isScanningActive ? handleBarcodeScanned : undefined}
              />

              {/* Sibling Target Overlay */}
              <View style={styles.reticleOverlay} pointerEvents="none">
                <View style={styles.cornerTL} />
                <View style={styles.cornerTR} />
                <View style={styles.cornerBL} />
                <View style={styles.cornerBR} />
                <View style={styles.scanLine} />
              </View>

              {/* Torch Toggle Button */}
              <TouchableOpacity
                style={styles.torchButton}
                onPress={() => setTorchEnabled((prev) => !prev)}
                activeOpacity={0.8}
              >
                <Text style={styles.torchIcon}>{torchEnabled ? '🔦 Torch ON' : '💡 Flash'}</Text>
              </TouchableOpacity>

              <View style={styles.cameraBottomBar}>
                <Text style={styles.cameraInstruction}>
                  Align barcode inside the violet markers
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* MODE 2: REAL LABEL PHOTO (CAMERA SNAPSHOT) */}
      {scanMode === 'label' && (
        <View style={styles.photoModeContainer}>
          <View style={styles.emptyActionCard}>
            <Text style={styles.emptyActionIcon}>📷</Text>
            <Text style={styles.emptyActionTitle}>Snap Food Label Photos</Text>
            <Text style={styles.emptyActionDesc}>
              Take clear photos of the ingredients panel and nutrition table on your food packaging.
            </Text>

            {/* Ingredients Photo Status / Action */}
            <View style={[styles.captureModuleCard, { width: '100%', marginBottom: 12 }]}>
              <View style={styles.captureModuleHeader}>
                <Text style={styles.captureModuleIcon}>🌿</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.captureModuleTitle}>Ingredients List Photo</Text>
                  <Text style={styles.captureModuleSub}>
                    {ingredientsPhoto ? '✓ Ingredients photo ready' : 'Not attached yet'}
                  </Text>
                </View>
                {ingredientsPhoto && (
                  <View style={styles.photoReadyBadge}>
                    <Text style={styles.photoReadyBadgeText}>Ready</Text>
                  </View>
                )}
              </View>

              {ingredientsPhoto ? (
                <View style={styles.thumbnailRow}>
                  <Image source={{ uri: ingredientsPhoto.uri }} style={styles.miniThumbnail} />
                  <View style={styles.thumbnailActionCol}>
                    <TouchableOpacity
                      style={styles.thumbnailBtn}
                      onPress={() => capturePhoto('ingredients')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.thumbnailBtnText}>📷 Retake</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                      onPress={() => setIngredientsPhoto(null)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.primaryScanButton}
                  onPress={() => capturePhoto('ingredients')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryScanButtonText}>📷 Snap Ingredients List</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Nutrition Table Photo Status / Action */}
            <View style={[styles.captureModuleCard, { width: '100%', marginBottom: 16 }]}>
              <View style={styles.captureModuleHeader}>
                <Text style={styles.captureModuleIcon}>📊</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.captureModuleTitle}>Nutrition Table Photo</Text>
                  <Text style={styles.captureModuleSub}>
                    {nutritionPhoto ? '✓ Nutrition table photo ready' : 'Not attached yet'}
                  </Text>
                </View>
                {nutritionPhoto && (
                  <View style={styles.photoReadyBadge}>
                    <Text style={styles.photoReadyBadgeText}>Ready</Text>
                  </View>
                )}
              </View>

              {nutritionPhoto ? (
                <View style={styles.thumbnailRow}>
                  <Image source={{ uri: nutritionPhoto.uri }} style={styles.miniThumbnail} />
                  <View style={styles.thumbnailActionCol}>
                    <TouchableOpacity
                      style={styles.thumbnailBtn}
                      onPress={() => capturePhoto('nutrition')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.thumbnailBtnText}>📷 Retake</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                      onPress={() => setNutritionPhoto(null)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.primaryScanButton, { backgroundColor: '#20133A', borderColor: '#7C3AED' }]}
                  onPress={() => capturePhoto('nutrition')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryScanButtonText}>📷 Snap Nutrition Facts Table</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* AI Analysis Trigger */}
            {(ingredientsPhoto || nutritionPhoto) && (
              <TouchableOpacity
                style={[styles.primaryScanButton, { width: '100%' }, isAnalyzingAi && { opacity: 0.7 }]}
                onPress={async () => {
                  await analyzeLabelsWithGemini();
                  setScanMode('barcode');
                }}
                disabled={isAnalyzingAi}
                activeOpacity={0.85}
              >
                {isAnalyzingAi ? (
                  <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 10 }} />
                ) : (
                  <Text style={styles.primaryScanIcon}>✨</Text>
                )}
                <View style={styles.primaryScanTextContainer}>
                  <Text style={styles.primaryScanButtonText}>
                    {isAnalyzingAi ? 'Analyzing Labels...' : 'Analyse Package Labels with Gemini AI'}
                  </Text>
                  <Text style={styles.primaryScanSubtext}>Extract ingredients, nutrition, and allergens</Text>
                </View>
              </TouchableOpacity>
            )}

            {/* Error Message */}
            {aiAnalysisError && (
              <View style={[styles.aiErrorBanner, { width: '100%', marginTop: 12 }]}>
                <Text style={styles.aiErrorIcon}>⚠️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiErrorTitle}>Analysis Notice</Text>
                  <Text style={styles.aiErrorDesc}>{aiAnalysisError}</Text>
                  <Text style={styles.aiErrorHint}>Your photos are preserved above so you can easily retry.</Text>
                </View>
              </View>
            )}
          </View>
        </View>
      )}

      {/* MODE 3: REAL GALLERY PHOTO PICKER */}
      {scanMode === 'gallery' && (
        <View style={styles.photoModeContainer}>
          <View style={styles.emptyActionCard}>
            <Text style={styles.emptyActionIcon}>🖼️</Text>
            <Text style={styles.emptyActionTitle}>Select Labels from Gallery</Text>
            <Text style={styles.emptyActionDesc}>
              Pick existing photos of the ingredients panel or nutrition table from your device gallery.
            </Text>

            {/* Ingredients Photo Status / Action */}
            <View style={[styles.captureModuleCard, { width: '100%', marginBottom: 12 }]}>
              <View style={styles.captureModuleHeader}>
                <Text style={styles.captureModuleIcon}>🌿</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.captureModuleTitle}>Ingredients List Photo</Text>
                  <Text style={styles.captureModuleSub}>
                    {ingredientsPhoto ? '✓ Ingredients photo ready' : 'Not attached yet'}
                  </Text>
                </View>
                {ingredientsPhoto && (
                  <View style={styles.photoReadyBadge}>
                    <Text style={styles.photoReadyBadgeText}>Ready</Text>
                  </View>
                )}
              </View>

              {ingredientsPhoto ? (
                <View style={styles.thumbnailRow}>
                  <Image source={{ uri: ingredientsPhoto.uri }} style={styles.miniThumbnail} />
                  <View style={styles.thumbnailActionCol}>
                    <TouchableOpacity
                      style={styles.thumbnailBtn}
                      onPress={() => pickPhotoFromGallery('ingredients')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.thumbnailBtnText}>🖼️ Choose Different</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                      onPress={() => setIngredientsPhoto(null)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.primaryScanButton}
                  onPress={() => pickPhotoFromGallery('ingredients')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryScanButtonText}>🖼️ Pick Ingredients Photo</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Nutrition Table Photo Status / Action */}
            <View style={[styles.captureModuleCard, { width: '100%', marginBottom: 16 }]}>
              <View style={styles.captureModuleHeader}>
                <Text style={styles.captureModuleIcon}>📊</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.captureModuleTitle}>Nutrition Table Photo</Text>
                  <Text style={styles.captureModuleSub}>
                    {nutritionPhoto ? '✓ Nutrition table photo ready' : 'Not attached yet'}
                  </Text>
                </View>
                {nutritionPhoto && (
                  <View style={styles.photoReadyBadge}>
                    <Text style={styles.photoReadyBadgeText}>Ready</Text>
                  </View>
                )}
              </View>

              {nutritionPhoto ? (
                <View style={styles.thumbnailRow}>
                  <Image source={{ uri: nutritionPhoto.uri }} style={styles.miniThumbnail} />
                  <View style={styles.thumbnailActionCol}>
                    <TouchableOpacity
                      style={styles.thumbnailBtn}
                      onPress={() => pickPhotoFromGallery('nutrition')}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.thumbnailBtnText}>🖼️ Choose Different</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thumbnailBtn, { backgroundColor: '#2D1525', borderColor: '#7E1D2D' }]}
                      onPress={() => setNutritionPhoto(null)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.thumbnailBtnText, { color: '#F87171' }]}>✕ Clear</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.primaryScanButton, { backgroundColor: '#20133A', borderColor: '#7C3AED' }]}
                  onPress={() => pickPhotoFromGallery('nutrition')}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryScanButtonText}>🖼️ Pick Nutrition Facts Table</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* AI Analysis Trigger */}
            {(ingredientsPhoto || nutritionPhoto) && (
              <TouchableOpacity
                style={[styles.primaryScanButton, { width: '100%' }, isAnalyzingAi && { opacity: 0.7 }]}
                onPress={async () => {
                  await analyzeLabelsWithGemini();
                  setScanMode('barcode');
                }}
                disabled={isAnalyzingAi}
                activeOpacity={0.85}
              >
                {isAnalyzingAi ? (
                  <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 10 }} />
                ) : (
                  <Text style={styles.primaryScanIcon}>✨</Text>
                )}
                <View style={styles.primaryScanTextContainer}>
                  <Text style={styles.primaryScanButtonText}>
                    {isAnalyzingAi ? 'Analyzing Labels...' : 'Analyse Package Labels with Gemini AI'}
                  </Text>
                  <Text style={styles.primaryScanSubtext}>Extract ingredients, nutrition, and allergens</Text>
                </View>
              </TouchableOpacity>
            )}

            {/* Error Message */}
            {aiAnalysisError && (
              <View style={[styles.aiErrorBanner, { width: '100%', marginTop: 12 }]}>
                <Text style={styles.aiErrorIcon}>⚠️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiErrorTitle}>Analysis Notice</Text>
                  <Text style={styles.aiErrorDesc}>{aiAnalysisError}</Text>
                  <Text style={styles.aiErrorHint}>Your photos are preserved above so you can easily retry.</Text>
                </View>
              </View>
            )}
          </View>
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );

  // --- SCREEN 4: PRODUCT RESULT OVERVIEW SCREEN ---
  const renderResultOverviewScreen = () => {
    if (!productData) {
      return (
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.screenHeader}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setCurrentScreen('scan')}
              activeOpacity={0.7}
            >
              <Text style={styles.backButtonText}>← Scan</Text>
            </TouchableOpacity>
            <Text style={styles.screenTitle}>Product Overview</Text>
            <View style={{ width: 60 }} />
          </View>
          <View style={styles.emptyStateCard}>
            <Text style={styles.emptyStateTitle}>No Product Selected</Text>
            <TouchableOpacity
              style={styles.primaryScanButton}
              onPress={() => setCurrentScreen('scan')}
            >
              <Text style={styles.primaryScanButtonText}>⚡ Scan a Product</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      );
    }

    const assessment = evaluatePersonalizedAssessment(productData, activePreferences);
    const scoreResult = calculateCompatibilityScore(assessment, activePreferences.length);

    const isAvoid = scoreResult.verdict === 'AVOID';
    const isCaution = scoreResult.verdict === 'CAUTION';
    const isNoConflict = scoreResult.verdict === 'NO IDENTIFIED CONFLICT';

    const verdictColor = isAvoid
      ? '#EF4444'
      : isCaution
      ? '#F59E0B'
      : isNoConflict
      ? '#10B981'
      : '#A855F7';

    const verdictBg = isAvoid
      ? 'rgba(239, 68, 68, 0.12)'
      : isCaution
      ? 'rgba(245, 158, 11, 0.12)'
      : isNoConflict
      ? 'rgba(16, 185, 129, 0.12)'
      : 'rgba(168, 85, 247, 0.12)';

    const provenanceText =
      productData.source === 'merged'
        ? '⚡ Merged (Package Photo + Database)'
        : productData.source === 'package_photo'
        ? '📷 Verified by Package Photo AI'
        : '🌐 Open Food Facts Database';

    let sodiumDisplay = 'Unavailable';
    if (
      productData.rawAiData?.nutrition_facts?.sodium_g !== undefined &&
      productData.rawAiData?.nutrition_facts?.sodium_g !== null
    ) {
      sodiumDisplay = `${Math.round(productData.rawAiData.nutrition_facts.sodium_g * 1000)}mg`;
    } else if (productData.nutrients.salt && productData.nutrients.salt !== 'Unavailable') {
      const match = productData.nutrients.salt.match(/([\d.]+)/);
      if (match) {
        const val = parseFloat(match[1]);
        if (productData.nutrients.salt.toLowerCase().includes('sodium')) {
          sodiumDisplay = `${Math.round(val * 1000)}mg`;
        } else {
          sodiumDisplay = `${Math.round((val / 2.5) * 1000)}mg`;
        }
      } else {
        sodiumDisplay = productData.nutrients.salt;
      }
    }

    return (
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Top Header */}
        <View style={styles.screenHeader}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => setCurrentScreen('scan')}
            activeOpacity={0.7}
          >
            <Text style={styles.backButtonText}>← Scan</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Product Overview</Text>
          <TouchableOpacity
            style={styles.profileButtonSmall}
            onPress={() => setCurrentScreen('profile')}
            activeOpacity={0.8}
          >
            <Text style={styles.profileAvatarSmallText}>⚙️</Text>
          </TouchableOpacity>
        </View>

        {/* Product Identity Card */}
        <View style={styles.overviewHeroCard}>
          <View style={styles.overviewHeroTopRow}>
            {productData.imageUrl ? (
              <Image source={{ uri: productData.imageUrl }} style={styles.overviewProductThumb} resizeMode="contain" />
            ) : (
              <View style={styles.overviewProductPlaceholder}>
                <Text style={styles.overviewProductPlaceholderText}>🍽️</Text>
              </View>
            )}
            <View style={styles.overviewHeroTextCol}>
              <View style={styles.provenancePill}>
                <Text style={styles.provenancePillText}>{provenanceText}</Text>
              </View>
              <Text style={styles.overviewProductName} numberOfLines={2}>
                {productData.name !== 'Unavailable' ? productData.name : 'Scanned Food Product'}
              </Text>
              <Text style={styles.overviewProductBrand} numberOfLines={1}>
                {productData.brand !== 'Unavailable' ? productData.brand : 'Brand Unavailable'}
                {productData.packageSize !== 'Unavailable' ? ` • ${productData.packageSize}` : ''}
              </Text>
            </View>
          </View>
        </View>

        {/* Big Compatibility Score Card */}
        <View style={[styles.scoreHeroCard, { borderColor: verdictColor, backgroundColor: verdictBg }]}>
          <View style={styles.scoreHeroTopRow}>
            <View style={styles.scoreCircleWrapper}>
              <View style={[styles.scoreCircle, { borderColor: verdictColor }]}>
                {scoreResult.score !== null ? (
                  <Text style={[styles.scoreNumber, { color: verdictColor }]}>
                    {scoreResult.score}
                  </Text>
                ) : (
                  <Text style={[styles.scoreNumberMuted, { color: verdictColor }]}>
                    --
                  </Text>
                )}
                <Text style={styles.scoreScale}>/ 100</Text>
              </View>
            </View>

            <View style={styles.verdictInfoCol}>
              <View style={styles.verdictBadgeRow}>
                <View style={[styles.verdictBadge, { backgroundColor: verdictColor }]}>
                  <Text style={styles.verdictBadgeText}>{scoreResult.verdict}</Text>
                </View>
                <TouchableOpacity
                  style={styles.infoIconButton}
                  onPress={() =>
                    setInfoModalContent({
                      title: 'About Compatibility Score',
                      text: `${scoreResult.scoreExplanation}\n\n• Score integrity: We never invent scores when ingredients or nutrition are missing.\n• Confirmed allergen conflicts immediately cap score at 0 (AVOID).\n• Cautionary flags deduct points for advisory traces or nutritional thresholds.\n\nDisclaimer: Informational guidance only; not medical advice.`,
                    })
                  }
                  activeOpacity={0.7}
                >
                  <Text style={styles.infoIconText}>ℹ️</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.verdictHeadline}>
                {scoreResult.headlineReason}
              </Text>
            </View>
          </View>

          {/* Packaging Conflict Callout */}
          {productData.conflicts && productData.conflicts.length > 0 && (
            <View style={styles.overviewConflictBanner}>
              <Text style={styles.overviewConflictIcon}>⚡</Text>
              <Text style={styles.overviewConflictText}>
                {`${productData.conflicts.length} package update(s) applied (package label took precedence over database).`}
              </Text>
            </View>
          )}

          {/* Missing Gaps Alert */}
          {(productData.missingGaps?.ingredientsMissing || productData.missingGaps?.nutritionMissing) && (
            <TouchableOpacity
              style={styles.overviewMissingGapBanner}
              onPress={() => setCurrentScreen('scan')}
              activeOpacity={0.8}
            >
              <Text style={styles.overviewMissingGapIcon}>📷</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.overviewMissingGapTitle}>Incomplete Product Data</Text>
                <Text style={styles.overviewMissingGapSub}>
                  {productData.missingGaps.ingredientsMissing
                    ? 'Ingredients missing. Tap here to photograph the package label.'
                    : 'Nutrition missing. Tap here to photograph the nutrition table.'}
                </Text>
              </View>
              <Text style={styles.overviewMissingGapArrow}>→</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Quick-Strip 4-Metric Nutrition Bar */}
        <View style={styles.quickStripContainer}>
          <View style={styles.quickStripHeaderRow}>
            <Text style={styles.quickStripTitle}>Nutrition Quick-Strip</Text>
            <Text style={styles.quickStripBasis}>
              {productData.servingSize ? `Per ${productData.servingSize}` : 'Per 100g'}
            </Text>
          </View>

          <View style={styles.quickStripRow}>
            <View style={styles.quickMetricCard}>
              <Text style={styles.quickMetricIcon}>🔥</Text>
              <Text style={styles.quickMetricValue}>
                {productData.nutrients.calories !== 'Unavailable' ? productData.nutrients.calories : '--'}
              </Text>
              <Text style={styles.quickMetricLabel}>Calories</Text>
            </View>

            <View style={styles.quickMetricCard}>
              <Text style={styles.quickMetricIcon}>🥩</Text>
              <Text style={styles.quickMetricValue}>
                {productData.nutrients.protein !== 'Unavailable' ? productData.nutrients.protein : '--'}
              </Text>
              <Text style={styles.quickMetricLabel}>Protein</Text>
            </View>

            <View style={styles.quickMetricCard}>
              <Text style={styles.quickMetricIcon}>🍬</Text>
              <Text style={styles.quickMetricValue}>
                {productData.nutrients.sugars !== 'Unavailable' ? productData.nutrients.sugars : '--'}
              </Text>
              <Text style={styles.quickMetricLabel}>Sugars</Text>
            </View>

            <View style={styles.quickMetricCard}>
              <Text style={styles.quickMetricIcon}>🧂</Text>
              <Text style={styles.quickMetricValue}>{sodiumDisplay !== 'Unavailable' ? sodiumDisplay : '--'}</Text>
              <Text style={styles.quickMetricLabel}>Sodium</Text>
            </View>
          </View>
        </View>

        {/* Primary Call to Action: Get More Details */}
        <TouchableOpacity
          style={styles.getMoreDetailsBtn}
          onPress={() => setCurrentScreen('details')}
          activeOpacity={0.85}
        >
          <View style={styles.getMoreDetailsContent}>
            <Text style={styles.getMoreDetailsTitle}>Get More Details & Full Breakdown</Text>
            <Text style={styles.getMoreDetailsSub}>
              Allergens, portion calculator, ingredients, additives & sources
            </Text>
          </View>
          <Text style={styles.getMoreDetailsArrow}>→</Text>
        </TouchableOpacity>

        {/* Secondary Call to Action: Scan Another */}
        <TouchableOpacity
          style={styles.secondaryScanButton}
          onPress={() => {
            resetBarcodeScanner();
            setCurrentScreen('scan');
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.secondaryScanButtonText}>⚡ Scan Another Item</Text>
        </TouchableOpacity>

        <View style={{ height: 32 }} />
      </ScrollView>
    );
  };

  // --- SCREEN 5: PRODUCT DETAILS & PROGRESSIVE DISCLOSURE SCREEN ---
  const renderProductDetailsScreen = () => {
    if (!productData) {
      return (
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <TouchableOpacity style={styles.backButton} onPress={() => setCurrentScreen('scan')}>
            <Text style={styles.backButtonText}>← Scan</Text>
          </TouchableOpacity>
        </ScrollView>
      );
    }

    const assessment = evaluatePersonalizedAssessment(productData, activePreferences);
    const scoreResult = calculateCompatibilityScore(assessment, activePreferences.length);

    // Dynamic Serving Factor Calculation
    const servingGrams = parseGramValue(productData.servingSize);
    const packGrams = parseGramValue(productData.packageSize);

    let scaleFactor = 1;
    let basisNote = 'Standard per 100g measurement';

    if (nutritionBasis === 'serving') {
      if (servingGrams) {
        scaleFactor = servingGrams / 100;
        basisNote = `Scaled for ${servingGrams}g serving size`;
      } else {
        scaleFactor = 1;
        basisNote = 'Serving weight unlisted in grams; displaying per 100g';
      }
    } else if (nutritionBasis === 'pack') {
      if (packGrams) {
        scaleFactor = packGrams / 100;
        basisNote = `Scaled for total package weight (${packGrams}g)`;
      } else {
        scaleFactor = 1;
        basisNote = 'Total package weight unlisted in grams; displaying per 100g';
      }
    }

    const scaledCalories = formatScaledNutrient(productData.nutrients.calories, scaleFactor, ' kcal');
    const scaledFat = formatScaledNutrient(productData.nutrients.fat, scaleFactor, 'g');
    const scaledSatFat = formatScaledNutrient(productData.nutrients.saturatedFat, scaleFactor, 'g');
    const scaledCarbs = formatScaledNutrient(productData.nutrients.carbs, scaleFactor, 'g');
    const scaledSugars = formatScaledNutrient(productData.nutrients.sugars, scaleFactor, 'g');
    const scaledFiber = formatScaledNutrient(productData.nutrients.fiber, scaleFactor, 'g');
    const scaledProtein = formatScaledNutrient(productData.nutrients.protein, scaleFactor, 'g');
    const scaledSalt = formatScaledNutrient(productData.nutrients.salt, scaleFactor, 'g');

    return (
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Top Header */}
        <View style={styles.screenHeader}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => setCurrentScreen('result')}
            activeOpacity={0.7}
          >
            <Text style={styles.backButtonText}>← Overview</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Full Breakdown</Text>
          <TouchableOpacity
            style={styles.infoIconButton}
            onPress={() =>
              setInfoModalContent({
                title: 'Data & Methodology',
                text: 'NutriLens extracts label data via Gemini Vision AI and Open Food Facts. All health ratings evaluate active user profile preferences. Values are general nutritional benchmarks, not personalized medical prescriptions.',
              })
            }
            activeOpacity={0.7}
          >
            <Text style={styles.infoIconText}>ℹ️</Text>
          </TouchableOpacity>
        </View>

        {/* Product Mini Header Card */}
        <View style={styles.detailsProductHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailsProductName} numberOfLines={1}>{productData.name}</Text>
            <Text style={styles.detailsProductSub} numberOfLines={1}>
              {productData.brand} • Barcode: {productData.barcode}
            </Text>
          </View>
          <View style={[styles.verdictBadgeSmall, {
            backgroundColor:
              scoreResult.verdict === 'AVOID' ? '#EF4444' :
              scoreResult.verdict === 'CAUTION' ? '#F59E0B' :
              scoreResult.verdict === 'NO IDENTIFIED CONFLICT' ? '#10B981' : '#8B5CF6'
          }]}>
            <Text style={styles.verdictBadgeSmallText}>{scoreResult.verdict}</Text>
          </View>
        </View>

        {/* SECTION 1: WHY THIS VERDICT? */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('verdict')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>🎯</Text>
              <Text style={styles.accordionTitle}>Why this verdict?</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.verdict ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.verdict && (
            <View style={styles.accordionBody}>
              <Text style={styles.accordionSummaryText}>{scoreResult.headlineReason}</Text>
              <Text style={styles.accordionSubSummary}>{scoreResult.scoreExplanation}</Text>

              {assessment.items.length > 0 ? (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.testedRulesTitle}>
                    {`Profile Rules Tested (${assessment.items.length}):`}
                  </Text>
                  {assessment.items.map((item) => (
                    <View
                      key={item.id}
                      style={[
                        styles.assessmentItemCard,
                        item.status === 'avoid'
                          ? styles.itemCardAvoid
                          : item.status === 'caution'
                          ? styles.itemCardCaution
                          : item.status === 'unable_to_assess'
                          ? styles.itemCardUnable
                          : styles.itemCardNoConflict,
                      ]}
                    >
                      <View style={styles.assessmentItemTopRow}>
                        <Text style={styles.assessmentItemRuleName}>{item.name}</Text>
                        <View
                          style={[
                            styles.itemMiniPill,
                            item.status === 'avoid'
                              ? styles.statusPillAvoid
                              : item.status === 'caution'
                              ? styles.statusPillCaution
                              : item.status === 'unable_to_assess'
                              ? styles.statusPillUnable
                              : styles.statusPillNoConflict,
                          ]}
                        >
                          <Text
                            style={[
                              styles.itemMiniPillText,
                              item.status === 'avoid'
                                ? styles.statusPillTextAvoid
                                : item.status === 'caution'
                                ? styles.statusPillTextCaution
                                : item.status === 'unable_to_assess'
                                ? styles.statusPillTextUnable
                                : styles.statusPillTextNoConflict,
                            ]}
                          >
                            {item.statusLabel}
                          </Text>
                        </View>
                      </View>

                      <Text style={styles.assessmentItemHeadline}>{item.headline}</Text>
                      <Text style={styles.assessmentItemEvidence}>{item.evidence}</Text>
                      {item.conflictWarning && (
                        <Text style={styles.itemConflictCallout}>⚡ {item.conflictWarning}</Text>
                      )}
                      <View style={styles.assessmentItemFooterRow}>
                        <Text style={styles.assessmentItemSource}>Source: {item.source}</Text>
                      </View>
                      {item.guidanceNote && (
                        <Text style={styles.assessmentItemGuidance}>ℹ️ {item.guidanceNote}</Text>
                      )}
                    </View>
                  ))}
                </View>
              ) : (
                <View style={styles.noFiltersBox}>
                  <Text style={styles.noFiltersText}>No active profile rules configured.</Text>
                  <TouchableOpacity
                    style={styles.setProfileBtn}
                    onPress={() => setCurrentScreen('profile')}
                  >
                    <Text style={styles.setProfileBtnText}>+ Customize Profile</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {/* SECTION 2: ALLERGENS & PRECAUTIONARY STATEMENTS */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('allergens')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>⚠️</Text>
              <Text style={styles.accordionTitle}>Allergens & Statements</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.allergens ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.allergens && (
            <View style={styles.accordionBody}>
              <View style={styles.detailBlock}>
                <Text style={styles.detailBlockLabel}>Declared Allergens on Package:</Text>
                <Text style={styles.detailBlockValue}>{productData.allergens}</Text>
              </View>

              {productData.rawAiData?.ingredients?.precautionary_statements &&
                productData.rawAiData.ingredients.precautionary_statements.length > 0 && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailBlockLabel}>Manufacturer Advisory (Cross-Contamination):</Text>
                    <Text style={styles.detailBlockValue}>
                      {productData.rawAiData.ingredients.precautionary_statements.join('; ')}
                    </Text>
                  </View>
                )}

              <View style={styles.strictWarningCallout}>
                <Text style={styles.strictWarningTitle}>Allergen Safety Guarantee Notice:</Text>
                <Text style={styles.strictWarningText}>
                  Missing or unreadable ingredients are NEVER treated as an assurance of allergen safety.
                  Always verify physical labels prior to consumption.
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* SECTION 3: NUTRITION BREAKDOWN & SERVING TOGGLE */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('nutrition')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>📊</Text>
              <Text style={styles.accordionTitle}>Nutrition & Serving Calculator</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.nutrition ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.nutrition && (
            <View style={styles.accordionBody}>
              {/* Serving Toggle Pills */}
              <View style={styles.basisPillsContainer}>
                <TouchableOpacity
                  style={[styles.basisPill, nutritionBasis === '100g' && styles.basisPillActive]}
                  onPress={() => setNutritionBasis('100g')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.basisPillText, nutritionBasis === '100g' && styles.basisPillTextActive]}>
                    Per 100g
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.basisPill, nutritionBasis === 'serving' && styles.basisPillActive]}
                  onPress={() => setNutritionBasis('serving')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.basisPillText, nutritionBasis === 'serving' && styles.basisPillTextActive]}>
                    {servingGrams ? `Per Serving (${servingGrams}g)` : 'Per Serving'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.basisPill, nutritionBasis === 'pack' && styles.basisPillActive]}
                  onPress={() => setNutritionBasis('pack')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.basisPillText, nutritionBasis === 'pack' && styles.basisPillTextActive]}>
                    {packGrams ? `Per Pack (${packGrams}g)` : 'Per Pack'}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.basisSubtitle}>{basisNote}</Text>

              {/* 8-Grid of Nutrients */}
              <View style={styles.nutritionGrid}>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🔥</Text>
                  <Text style={styles.nutritionCardLabel}>Calories</Text>
                  <Text style={styles.nutritionCardValue}>{scaledCalories}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🥑</Text>
                  <Text style={styles.nutritionCardLabel}>Total Fat</Text>
                  <Text style={styles.nutritionCardValue}>{scaledFat}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🥓</Text>
                  <Text style={styles.nutritionCardLabel}>Sat. Fat</Text>
                  <Text style={styles.nutritionCardValue}>{scaledSatFat}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🍞</Text>
                  <Text style={styles.nutritionCardLabel}>Carbs</Text>
                  <Text style={styles.nutritionCardValue}>{scaledCarbs}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🍬</Text>
                  <Text style={styles.nutritionCardLabel}>Sugars</Text>
                  <Text style={styles.nutritionCardValue}>{scaledSugars}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🌾</Text>
                  <Text style={styles.nutritionCardLabel}>Fiber</Text>
                  <Text style={styles.nutritionCardValue}>{scaledFiber}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🥩</Text>
                  <Text style={styles.nutritionCardLabel}>Protein</Text>
                  <Text style={styles.nutritionCardValue}>{scaledProtein}</Text>
                </View>
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCardIcon}>🧂</Text>
                  <Text style={styles.nutritionCardLabel}>Salt</Text>
                  <Text style={styles.nutritionCardValue}>{scaledSalt}</Text>
                </View>
              </View>

              <Text style={styles.nutritionClinicalDisclaimer}>
                General portion note: Portion estimates are calculated mathematically from printed packaging numbers.
                These are informational benchmarks, not individual clinical prescriptions.
              </Text>
            </View>
          )}
        </View>

        {/* SECTION 4: INGREDIENTS & ADDITIVES */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('ingredients')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>🌿</Text>
              <Text style={styles.accordionTitle}>Ingredients & Additives</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.ingredients ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.ingredients && (
            <View style={styles.accordionBody}>
              {/* Nutri-Score & NOVA Badges */}
              <View style={styles.scoreRow}>
                {productData.nutriScore ? (
                  <View
                    style={[
                      styles.scoreBadge,
                      {
                        backgroundColor:
                          productData.nutriScore === 'A'
                            ? '#059669'
                            : productData.nutriScore === 'B'
                            ? '#65A30D'
                            : productData.nutriScore === 'C'
                            ? '#D97706'
                            : productData.nutriScore === 'D'
                            ? '#EA580C'
                            : '#DC2626',
                      },
                    ]}
                  >
                    <Text style={styles.scoreBadgeLabel}>NUTRI-SCORE</Text>
                    <Text style={styles.scoreBadgeValue}>{productData.nutriScore}</Text>
                  </View>
                ) : (
                  <View style={[styles.scoreBadge, { backgroundColor: '#372750' }]}>
                    <Text style={styles.scoreBadgeLabel}>NUTRI-SCORE</Text>
                    <Text style={[styles.scoreBadgeValue, { fontSize: 13 }]}>Unavailable</Text>
                  </View>
                )}

                {productData.novaGroup !== null && (
                  <View
                    style={[
                      styles.novaBadge,
                      {
                        backgroundColor:
                          productData.novaGroup === 1
                            ? '#047857'
                            : productData.novaGroup === 2
                            ? '#2563EB'
                            : productData.novaGroup === 3
                            ? '#D97706'
                            : '#B91C1C',
                      },
                    ]}
                  >
                    <Text style={styles.novaBadgeLabel}>NOVA GROUP {productData.novaGroup}</Text>
                    <Text style={styles.novaBadgeDesc}>
                      {productData.novaGroup === 1
                        ? 'Unprocessed'
                        : productData.novaGroup === 2
                        ? 'Culinary'
                        : productData.novaGroup === 3
                        ? 'Processed'
                        : 'Ultra-Processed'}
                    </Text>
                  </View>
                )}
              </View>

              <Text style={styles.ingredientsVerbatimTitle}>Visible Packaging Ingredients:</Text>
              <Text style={styles.ingredientsVerbatimText}>{productData.ingredients}</Text>
            </View>
          )}
        </View>

        {/* SECTION 5: DATA SOURCES & AUDIT TRAIL */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('sources')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>📑</Text>
              <Text style={styles.accordionTitle}>Data Sources & Conflict Audit</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.sources ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.sources && (
            <View style={styles.accordionBody}>
              <View style={styles.detailBlock}>
                <Text style={styles.detailBlockLabel}>Active Provenance:</Text>
                <Text style={styles.detailBlockValue}>
                  {productData.source === 'merged'
                    ? 'Merged Record: Package label photo OCR verified with Open Food Facts database'
                    : productData.source === 'package_photo'
                    ? 'Package Label AI: Extracted directly from photos using Gemini 3.8 Flash'
                    : 'Open Food Facts: World database crowd-sourced record'}
                </Text>
              </View>

              {productData.conflicts && productData.conflicts.length > 0 ? (
                <View style={styles.conflictCard}>
                  <Text style={styles.conflictTitle}>⚡ Packaging Precedence Audit:</Text>
                  <Text style={styles.conflictDesc}>
                    When package label photos contradict the online database, physical package text takes precedence:
                  </Text>
                  {productData.conflicts.map((c, i) => (
                    <View key={i} style={styles.conflictRow}>
                      <Text style={styles.conflictField}>{c.field}:</Text>
                      <Text style={styles.conflictValue}>
                        {c.packagingValue}{' '}
                        <Text style={styles.conflictOld}>(DB had: {c.databaseValue})</Text>
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.noConflictsText}>✓ No database discrepancies detected.</Text>
              )}
            </View>
          )}
        </View>

        {/* SECTION 6: SAFETY LIMITATIONS & MEDICAL ADVISORY */}
        <View style={styles.accordionCard}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleSection('disclaimer')}
            activeOpacity={0.8}
          >
            <View style={styles.accordionHeaderLeft}>
              <Text style={styles.accordionIcon}>🛡️</Text>
              <Text style={styles.accordionTitle}>Safety & Medical Advisory</Text>
            </View>
            <Text style={styles.accordionToggle}>{expandedSections.disclaimer ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandedSections.disclaimer && (
            <View style={styles.accordionBody}>
              <View style={styles.assessmentDisclaimerContainer}>
                <Text style={styles.assessmentDisclaimerTitle}>⚠️ Critical Medical Notice:</Text>
                <Text style={styles.assessmentDisclaimerText}>
                  • NutriLens is an informational screening assistant, not a clinical diagnostic medical device.
                </Text>
                <Text style={styles.assessmentDisclaimerText}>
                  • Automated computer vision processes visible label text only. It cannot detect factory recipe revisions, unphotographed package panels, or undisclosed cross-contamination.
                </Text>
                <Text style={styles.assessmentDisclaimerText}>
                  • If you have severe anaphylactic allergies, always inspect physical packaging and consult medical professionals before consumption.
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Bottom Navigation Buttons */}
        <TouchableOpacity
          style={styles.primaryScanButton}
          onPress={() => setCurrentScreen('result')}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryScanButtonText}>← Back to Overview</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryScanButton}
          onPress={() => {
            resetBarcodeScanner();
            setCurrentScreen('scan');
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.secondaryScanButtonText}>⚡ Scan Another Item</Text>
        </TouchableOpacity>

        <View style={{ height: 32 }} />
      </ScrollView>
    );
  };

  // --- SCREEN 2: COMPARE FOODS SCREEN ---
  const renderCompareScreen = () => (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Top Header */}
      <View style={styles.screenHeader}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => setCurrentScreen('home')}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>← Home</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Compare Foods</Text>
        <View style={{ width: 60 }} />
      </View>

      <Text style={styles.screenSubtitle}>
        Side-by-side nutritional duel to compare health scores and ingredients.
      </Text>

      {/* Duel Slots Container */}
      <View style={styles.compareSlotsRow}>
        <View style={styles.compareSlotCard}>
          <View style={styles.compareSlotBadge}>
            <Text style={styles.compareSlotBadgeText}>PRODUCT 1</Text>
          </View>
          <Text style={styles.compareEmptyIcon}>🍽️</Text>
          <Text style={styles.compareSlotTitle}>Product A</Text>
          <Text style={styles.compareSlotMuted}>Empty slot</Text>
        </View>

        <View style={styles.versusCircle}>
          <Text style={styles.versusText}>VS</Text>
        </View>

        <View style={styles.compareSlotCard}>
          <View style={[styles.compareSlotBadge, { backgroundColor: '#EC4899' }]}>
            <Text style={styles.compareSlotBadgeText}>PRODUCT 2</Text>
          </View>
          <Text style={styles.compareEmptyIcon}>🥤</Text>
          <Text style={styles.compareSlotTitle}>Product B</Text>
          <Text style={styles.compareSlotMuted}>Empty slot</Text>
        </View>
      </View>

      {/* Prompt Card */}
      <View style={styles.compareInfoCard}>
        <Text style={styles.compareInfoTitle}>No Products Selected</Text>
        <Text style={styles.compareInfoDesc}>
          Scan two packaged food items to compare calories, sugars, sodium levels, and hidden chemical additives side by side.
        </Text>

        <TouchableOpacity
          style={styles.primaryScanButton}
          onPress={() => {
            setScanMode('barcode');
            setIsScanningActive(true);
            setCurrentScreen('scan');
          }}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryScanIcon}>📷</Text>
          <View style={styles.primaryScanTextContainer}>
            <Text style={styles.primaryScanButtonText}>Scan First Product</Text>
            <Text style={styles.primaryScanSubtext}>Scan barcode to add to comparison</Text>
          </View>
          <Text style={styles.arrowIcon}>→</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 32 }} />
    </ScrollView>
  );

  // --- SCREEN 3: HEALTH & DIET PROFILE SCREEN ---
  const renderProfileScreen = () => {
    const allergenList = ['Gluten', 'Peanuts', 'Dairy / Lactose', 'Soy', 'Shellfish', 'Eggs', 'Tree Nuts'];
    const goalList = ['Low Sodium', 'No Added Sugar', 'High Protein', 'Keto Friendly', 'Vegan', 'Organic Only'];

    return (
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Top Header */}
        <View style={styles.screenHeader}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => setCurrentScreen('home')}
            activeOpacity={0.7}
          >
            <Text style={styles.backButtonText}>← Home</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Health Profile</Text>
          <View style={{ width: 60 }} />
        </View>

        <Text style={styles.screenSubtitle}>
          Tap any item to customize your active health rules and allergen flags.
        </Text>

        {/* Section 1: Allergens */}
        <View style={styles.profileSectionCard}>
          <Text style={styles.profileSectionTitle}>⚠️ Allergen Warnings</Text>
          <Text style={styles.profileSectionDesc}>
            NutriLens will alert you if any scanned ingredients match these:
          </Text>
          <View style={styles.pillContainer}>
            {allergenList.map((item) => {
              const tagLabel = item.includes('/') ? item : `${item}-Free`;
              const active = activePreferences.includes(item) || activePreferences.includes(tagLabel);

              return (
                <TouchableOpacity
                  key={item}
                  style={[styles.profilePill, active && styles.profilePillActive]}
                  onPress={() => togglePreference(tagLabel)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.profilePillText, active && styles.profilePillTextActive]}>
                    {active ? '✓ ' : '+ '}
                    {tagLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Section 2: Nutrition Goals */}
        <View style={styles.profileSectionCard}>
          <Text style={styles.profileSectionTitle}>🎯 Nutrition Goals & Diets</Text>
          <Text style={styles.profileSectionDesc}>
            Prioritize or flag foods based on your dietary guidelines:
          </Text>
          <View style={styles.pillContainer}>
            {goalList.map((item) => {
              const active = activePreferences.includes(item);
              return (
                <TouchableOpacity
                  key={item}
                  style={[styles.profilePill, active && styles.profilePillActive]}
                  onPress={() => togglePreference(item)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.profilePillText, active && styles.profilePillTextActive]}>
                    {active ? '✓ ' : '+ '}
                    {item}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Active Rules Summary Card */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>
            Active Filters ({activePreferences.length})
          </Text>
          <Text style={styles.summaryDesc}>
            {activePreferences.length > 0
              ? activePreferences.join(' • ')
              : 'No active filters. Tap any pill above to add rules.'}
          </Text>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    );
  };

  // --- SCREEN 0: HOME SCREEN ---
  const renderHomeScreen = () => (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Top Header Bar */}
      <View style={styles.header}>
        <View>
          <View style={styles.brandRow}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoIcon}>✦</Text>
            </View>
            <Text style={styles.appName}>NutriLens</Text>
            <View style={styles.aiBadge}>
              <View style={styles.aiPulseDot} />
              <Text style={styles.aiBadgeText}>AI 2.0</Text>
            </View>
          </View>
          <Text style={styles.headerSubtitle}>Food & Nutrition Intelligence</Text>
        </View>

        {/* Profile Shortcut Avatar */}
        <TouchableOpacity
          style={styles.profileButton}
          onPress={() => setCurrentScreen('profile')}
          activeOpacity={0.8}
        >
          <Text style={styles.profileAvatarText}>👤</Text>
        </TouchableOpacity>
      </View>

      {/* Hero Welcome Card */}
      <View style={styles.heroCard}>
        <View style={styles.heroTagRow}>
          <Text style={styles.heroTag}>⚡ INSTANT ANALYSIS</Text>
          <Text style={styles.heroTagMuted}>Barcode & Photo OCR</Text>
        </View>
        <Text style={styles.heroTitle}>Know what you eat before you take a bite.</Text>
        <Text style={styles.heroDescription}>
          Scan food labels to decode harmful additives, check allergen alerts, and get honest AI-driven health scores.
        </Text>

        {/* Primary Action Button: Navigates Directly to Live Barcode Scanner */}
        <TouchableOpacity
          style={styles.primaryScanButton}
          onPress={() => {
            setScanMode('barcode');
            setIsScanningActive(true);
            setCurrentScreen('scan');
          }}
          activeOpacity={0.85}
        >
          <View style={styles.scanButtonGlow} />
          <Text style={styles.primaryScanIcon}>📷</Text>
          <View style={styles.primaryScanTextContainer}>
            <Text style={styles.primaryScanButtonText}>Scan a Food Product</Text>
            <Text style={styles.primaryScanSubtext}>Point camera at barcode or nutrition facts</Text>
          </View>
          <Text style={styles.arrowIcon}>→</Text>
        </TouchableOpacity>
      </View>

      {/* Secondary Action Grid */}
      <View style={styles.actionGrid}>
        {/* Upload Photo: Navigates Directly to Gallery Picker */}
        <TouchableOpacity
          style={styles.secondaryActionCard}
          onPress={() => {
            setScanMode('gallery');
            setIsScanningActive(false);
            setCurrentScreen('scan');
          }}
          activeOpacity={0.8}
        >
          <View style={styles.actionIconContainer}>
            <Text style={styles.actionIcon}>🖼️</Text>
          </View>
          <Text style={styles.actionCardTitle}>Upload Photo</Text>
          <Text style={styles.actionCardDesc}>Analyze label from your phone gallery</Text>
        </TouchableOpacity>

        {/* Compare Foods: Navigates Directly to Compare Screen */}
        <TouchableOpacity
          style={styles.secondaryActionCard}
          onPress={() => setCurrentScreen('compare')}
          activeOpacity={0.8}
        >
          <View style={[styles.actionIconContainer, styles.compareIconContainer]}>
            <Text style={styles.actionIcon}>⚖️</Text>
          </View>
          <Text style={styles.actionCardTitle}>Compare Foods</Text>
          <Text style={styles.actionCardDesc}>Side-by-side nutrition duel</Text>
        </TouchableOpacity>
      </View>

      {/* Dietary Preferences & Allergy Profile Banner */}
      <TouchableOpacity
        style={styles.dietProfileCard}
        onPress={() => setCurrentScreen('profile')}
        activeOpacity={0.85}
      >
        <View style={styles.dietProfileHeader}>
          <View style={styles.dietProfileTitleRow}>
            <Text style={styles.dietProfileIcon}>🛡️</Text>
            <Text style={styles.dietProfileTitle}>Allergies & Nutrition Profile</Text>
          </View>
          <Text style={styles.dietManageText}>Edit →</Text>
        </View>
        <Text style={styles.dietProfileSubtitle}>
          Custom rules active to flag allergens in real time:
        </Text>
        <View style={styles.pillContainer}>
          {activePreferences.slice(0, 4).map((pref) => (
            <View key={pref} style={styles.activePill}>
              <Text style={styles.activePillDot}>•</Text>
              <Text style={styles.activePillText}>{pref}</Text>
            </View>
          ))}
          {activePreferences.length === 0 && (
            <Text style={styles.noPreferencesText}>Tap Edit to set your allergies & diet goals.</Text>
          )}
        </View>
      </TouchableOpacity>

      {/* Recent Scans Section */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Recent Scans</Text>
        <View style={styles.counterBadge}>
          <Text style={styles.counterText}>
            {scannedBarcode ? '1 Scanned' : '0 Scanned'}
          </Text>
        </View>
      </View>

      {/* Scanned item if any, otherwise empty state */}
      {productData ? (
        <View style={styles.recentItemCard}>
          <View style={styles.recentItemHeader}>
            <Text style={styles.recentItemName} numberOfLines={1}>
              {productData.name}
            </Text>
            {productData.nutriScore && (
              <View
                style={[
                  styles.recentScoreBadge,
                  {
                    backgroundColor:
                      productData.nutriScore === 'A'
                        ? '#059669'
                        : productData.nutriScore === 'B'
                        ? '#65A30D'
                        : productData.nutriScore === 'C'
                        ? '#D97706'
                        : productData.nutriScore === 'D'
                        ? '#EA580C'
                        : '#DC2626',
                  },
                ]}
              >
                <Text style={styles.recentScoreText}>Score {productData.nutriScore}</Text>
              </View>
            )}
          </View>
          <Text style={styles.recentItemBrand} numberOfLines={1}>
            {productData.brand} • {productData.packageSize}
          </Text>
          <Text style={styles.recentItemCalories}>
            🔥 {productData.nutrients.calories} • Barcode: {productData.barcode}
          </Text>

          <View style={styles.recentActionRow}>
            <TouchableOpacity
              style={styles.recentItemViewDetails}
              onPress={() => {
                setCurrentScreen('result');
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.recentItemViewDetailsText}>View Nutrition & Ingredients →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.recentItemScanAgain}
              onPress={() => {
                setScanMode('barcode');
                resetBarcodeScanner();
                setCurrentScreen('scan');
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.recentItemScanAgainText}>Scan Another</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : scannedBarcode ? (
        <View style={styles.recentItemCard}>
          <View style={styles.recentItemHeader}>
            <Text style={styles.recentItemBarcode}>Barcode: {scannedBarcode.data}</Text>
            <Text style={styles.recentItemTime}>{scannedBarcode.scannedAt}</Text>
          </View>
          <Text style={styles.recentItemFormat}>
            {isLoadingProduct
              ? 'Fetching Open Food Facts data...'
              : productNotFound
              ? 'Item not found in database'
              : `Type: ${scannedBarcode.type.toUpperCase()}`}
          </Text>
          <TouchableOpacity
            style={styles.recentItemScanAgain}
            onPress={() => {
              setScanMode('barcode');
              resetBarcodeScanner();
              setCurrentScreen('scan');
            }}
          >
            <Text style={styles.recentItemScanAgainText}>Scan Another Item →</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.emptyStateCard}>
          <View style={styles.emptyStateIconCircle}>
            <Text style={styles.emptyStateIcon}>🥗</Text>
          </View>
          <Text style={styles.emptyStateTitle}>No Food Scanned Yet</Text>
          <Text style={styles.emptyStateDesc}>
            Your analyzed products, ingredient risk alerts, and nutritional grades will be saved here automatically.
          </Text>
          <View style={styles.tipBox}>
            <Text style={styles.tipIcon}>💡</Text>
            <Text style={styles.tipText}>
              <Text style={styles.tipHighlight}>Beginner Tip: </Text>
              {"Tap 'Scan a Food Product' and point your camera at any barcode in your kitchen."}
            </Text>
          </View>
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );

  return (
    <View style={styles.safeArea}>
      <StatusBar style="light" />
      {currentScreen === 'home' && renderHomeScreen()}
      {currentScreen === 'scan' && renderScanScreen()}
      {currentScreen === 'result' && renderResultOverviewScreen()}
      {currentScreen === 'details' && renderProductDetailsScreen()}
      {currentScreen === 'compare' && renderCompareScreen()}
      {currentScreen === 'profile' && renderProfileScreen()}

      {/* Info Explanation Modal Overlay */}
      {infoModalContent && (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>{infoModalContent.title}</Text>
              <TouchableOpacity onPress={() => setInfoModalContent(null)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 340 }}>
              <Text style={styles.modalText}>{infoModalContent.text}</Text>
            </ScrollView>
            <TouchableOpacity
              style={styles.modalActionBtn}
              onPress={() => setInfoModalContent(null)}
              activeOpacity={0.85}
            >
              <Text style={styles.modalActionBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#09070F',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
  },
  // Headers & Titles
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 22,
    paddingTop: 8,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#8B5CF6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 8,
    elevation: 6,
  },
  logoIcon: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },
  appName: {
    fontSize: 24,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1238',
    borderColor: '#7C3AED',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    marginLeft: 4,
  },
  aiPulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#A855F7',
    marginRight: 5,
  },
  aiBadgeText: {
    color: '#D8B4FE',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  headerSubtitle: {
    color: '#8A859E',
    fontSize: 13,
    marginTop: 3,
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#161127',
    borderColor: '#2D1F50',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#A855F7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  profileAvatarText: {
    fontSize: 20,
  },
  // Sub-screen Headers
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingTop: 8,
  },
  backButton: {
    backgroundColor: '#18112C',
    borderColor: '#362164',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
  },
  backButtonText: {
    color: '#A855F7',
    fontSize: 13,
    fontWeight: '700',
  },
  screenTitle: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '800',
  },
  screenSubtitle: {
    color: '#8E87AA',
    fontSize: 13,
    marginBottom: 20,
    lineHeight: 18,
  },
  // Hero Card
  heroCard: {
    backgroundColor: '#140E26',
    borderColor: '#2F1E5C',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 6,
  },
  heroTagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  heroTag: {
    color: '#EC4899',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  heroTagMuted: {
    color: '#716A8C',
    fontSize: 11,
    fontWeight: '600',
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 28,
    marginBottom: 8,
  },
  heroDescription: {
    color: '#A39BBF',
    fontSize: 13.5,
    lineHeight: 20,
    marginBottom: 18,
  },
  primaryScanButton: {
    backgroundColor: '#7C3AED',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#A855F7',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: '#C084FC',
  },
  scanButtonGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 16,
  },
  primaryScanIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  primaryScanTextContainer: {
    flex: 1,
  },
  primaryScanButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  primaryScanSubtext: {
    color: '#E9D5FF',
    fontSize: 11.5,
    marginTop: 2,
  },
  arrowIcon: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginLeft: 8,
  },
  // Secondary Action Grid
  actionGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  secondaryActionCard: {
    flex: 1,
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
  },
  actionIconContainer: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#26154A',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  compareIconContainer: {
    backgroundColor: '#2D123D',
  },
  actionIcon: {
    fontSize: 18,
  },
  actionCardTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '700',
    marginBottom: 4,
  },
  actionCardDesc: {
    color: '#847D9E',
    fontSize: 11.5,
    lineHeight: 16,
  },
  // Diet & Allergy Profile Banner
  dietProfileCard: {
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginBottom: 24,
  },
  dietProfileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  dietProfileTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dietProfileIcon: {
    fontSize: 16,
  },
  dietProfileTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '700',
  },
  dietManageText: {
    color: '#A855F7',
    fontSize: 12,
    fontWeight: '700',
  },
  dietProfileSubtitle: {
    color: '#847D9E',
    fontSize: 12,
    marginBottom: 10,
  },
  pillContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1B1333',
    borderColor: '#4C2889',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  activePillDot: {
    color: '#10B981',
    fontSize: 14,
    marginRight: 5,
  },
  activePillText: {
    color: '#D8B4FE',
    fontSize: 11.5,
    fontWeight: '600',
  },
  noPreferencesText: {
    color: '#847D9E',
    fontSize: 12,
    fontStyle: 'italic',
  },
  // Mode Selector Tabs (Scan Screen)
  modeTabsContainer: {
    flexDirection: 'row',
    backgroundColor: '#130E24',
    borderColor: '#2A1B4E',
    borderWidth: 1,
    borderRadius: 14,
    padding: 4,
    marginBottom: 18,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
  },
  modeTabActive: {
    backgroundColor: '#7C3AED',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  modeTabText: {
    color: '#8A83A6',
    fontSize: 13,
    fontWeight: '600',
  },
  modeTabTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  // Live Camera Container (No children inside CameraView)
  liveCameraContainer: {
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderColor: '#371E68',
    borderWidth: 2,
    height: 380,
    marginBottom: 16,
    position: 'relative',
  },
  reticleOverlay: {
    position: 'absolute',
    top: '15%',
    left: '12%',
    right: '12%',
    bottom: '22%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerTL: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 26,
    height: 26,
    borderTopWidth: 3.5,
    borderLeftWidth: 3.5,
    borderColor: '#C084FC',
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 26,
    height: 26,
    borderTopWidth: 3.5,
    borderRightWidth: 3.5,
    borderColor: '#C084FC',
    borderTopRightRadius: 6,
  },
  cornerBL: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 26,
    height: 26,
    borderBottomWidth: 3.5,
    borderLeftWidth: 3.5,
    borderColor: '#C084FC',
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderBottomWidth: 3.5,
    borderRightWidth: 3.5,
    borderColor: '#C084FC',
    borderBottomRightRadius: 6,
  },
  scanLine: {
    width: '90%',
    height: 2,
    backgroundColor: '#EC4899',
    shadowColor: '#EC4899',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
  },
  torchButton: {
    position: 'absolute',
    top: 14,
    right: 14,
    backgroundColor: 'rgba(20, 12, 38, 0.75)',
    borderColor: '#7C3AED',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    zIndex: 10,
  },
  torchIcon: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  cameraBottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0F0B1E',
    paddingVertical: 10,
  },
  cameraInstruction: {
    textAlign: 'center',
    color: '#C4B5FD',
    fontSize: 12.5,
  },
  // Permission Card
  permissionCard: {
    backgroundColor: '#140E26',
    borderColor: '#371F69',
    borderWidth: 1.5,
    borderRadius: 22,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  permissionIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  permissionTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 8,
  },
  permissionDesc: {
    color: '#9E97BA',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  // Result Card (Real Scanned Barcode)
  resultCard: {
    backgroundColor: '#150E2A',
    borderColor: '#7C3AED',
    borderWidth: 1.5,
    borderRadius: 22,
    padding: 22,
    marginBottom: 18,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  resultBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#27114A',
    borderColor: '#9333EA',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: 12,
  },
  resultBadgeText: {
    color: '#E9D5FF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  barcodeData: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '900',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginBottom: 14,
  },
  barcodeMetaRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  barcodeMetaLabel: {
    color: '#847D9E',
    fontSize: 13,
  },
  barcodeMetaValue: {
    color: '#D8B4FE',
    fontSize: 13,
    fontWeight: '700',
  },
  infoCallout: {
    flexDirection: 'row',
    backgroundColor: '#1C1338',
    borderColor: '#432578',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginTop: 14,
    marginBottom: 18,
  },
  infoCalloutIcon: {
    fontSize: 16,
  },
  infoCalloutText: {
    flex: 1,
    color: '#C4B5FD',
    fontSize: 11.5,
    lineHeight: 16,
  },
  // Photo Mode & Gallery
  photoModeContainer: {
    marginBottom: 16,
  },
  emptyActionCard: {
    backgroundColor: '#130E26',
    borderColor: '#2F1E5C',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
  },
  emptyActionIcon: {
    fontSize: 44,
    marginBottom: 12,
  },
  emptyActionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },
  emptyActionDesc: {
    color: '#9E97BA',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  photoPreviewCard: {
    backgroundColor: '#130E26',
    borderColor: '#371F69',
    borderWidth: 1.5,
    borderRadius: 22,
    padding: 18,
  },
  photoPreviewTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  photoPreviewImage: {
    width: '100%',
    height: 240,
    borderRadius: 14,
    backgroundColor: '#000000',
    marginBottom: 12,
  },
  photoActionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  smallActionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4E2C84',
  },
  smallActionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  // Recent Scans
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  counterBadge: {
    backgroundColor: '#1A1230',
    borderColor: '#362164',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  counterText: {
    color: '#A855F7',
    fontSize: 11,
    fontWeight: '700',
  },
  recentItemCard: {
    backgroundColor: '#140E26',
    borderColor: '#382269',
    borderWidth: 1.5,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  recentItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  recentItemBarcode: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },
  recentItemTime: {
    color: '#847D9E',
    fontSize: 12,
  },
  recentItemFormat: {
    color: '#A855F7',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 10,
  },
  recentItemScanAgain: {
    alignSelf: 'flex-start',
    backgroundColor: '#261548',
    borderColor: '#6D28D9',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  recentItemScanAgainText: {
    color: '#D8B4FE',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyStateCard: {
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 22,
    padding: 22,
    alignItems: 'center',
  },
  emptyStateIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1B1133',
    borderColor: '#391F6D',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyStateIcon: {
    fontSize: 28,
  },
  emptyStateTitle: {
    color: '#FFFFFF',
    fontSize: 16.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptyStateDesc: {
    color: '#847D9E',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 16,
  },
  tipBox: {
    flexDirection: 'row',
    backgroundColor: '#1A1333',
    borderColor: '#402175',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    alignItems: 'flex-start',
    gap: 8,
  },
  tipIcon: {
    fontSize: 16,
    marginTop: 1,
  },
  tipText: {
    flex: 1,
    color: '#B5AECB',
    fontSize: 11.5,
    lineHeight: 16,
  },
  tipHighlight: {
    color: '#E9D5FF',
    fontWeight: '700',
  },
  // Compare Screen Styles
  compareSlotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  compareSlotCard: {
    flex: 1,
    backgroundColor: '#120D22',
    borderColor: '#261848',
    borderWidth: 1.5,
    borderRadius: 20,
    padding: 16,
    alignItems: 'center',
  },
  compareSlotBadge: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginBottom: 12,
  },
  compareSlotBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  compareEmptyIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  compareSlotTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '700',
  },
  compareSlotMuted: {
    color: '#766F91',
    fontSize: 11.5,
    marginTop: 2,
  },
  versusCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#20123C',
    borderColor: '#7C3AED',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  versusText: {
    color: '#D8B4FE',
    fontSize: 12,
    fontWeight: '900',
  },
  compareInfoCard: {
    backgroundColor: '#130E26',
    borderColor: '#291A50',
    borderWidth: 1.5,
    borderRadius: 22,
    padding: 20,
    alignItems: 'center',
  },
  compareInfoTitle: {
    color: '#FFFFFF',
    fontSize: 16.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  compareInfoDesc: {
    color: '#8E87AA',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 18,
  },
  // Profile Screen Styles
  profileSectionCard: {
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
  },
  profileSectionTitle: {
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '700',
    marginBottom: 4,
  },
  profileSectionDesc: {
    color: '#847D9E',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 14,
  },
  profilePill: {
    backgroundColor: '#17112B',
    borderColor: '#301F57',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  profilePillActive: {
    backgroundColor: '#2E1256',
    borderColor: '#A855F7',
  },
  profilePillText: {
    color: '#8E87AA',
    fontSize: 12.5,
    fontWeight: '600',
  },
  profilePillTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  summaryCard: {
    backgroundColor: '#171030',
    borderColor: '#4A2784',
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
  },
  summaryTitle: {
    color: '#A855F7',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  summaryDesc: {
    color: '#E9D5FF',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  // Loading State
  loadingCard: {
    backgroundColor: '#150E2A',
    borderColor: '#7C3AED',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    marginBottom: 18,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  loadingSpinnerContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#261448',
    borderColor: '#9333EA',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  loadingTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },
  loadingSubtitle: {
    color: '#A39BBF',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  loadingBarcodeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#20123D',
    borderColor: '#6B21A8',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    gap: 6,
  },
  loadingBarcodeLabel: {
    color: '#8E87AA',
    fontSize: 12,
  },
  loadingBarcodeValue: {
    color: '#D8B4FE',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },

  // Not Found State
  notFoundCard: {
    backgroundColor: '#140E26',
    borderColor: '#371E68',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    marginBottom: 18,
  },
  notFoundIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#23123E',
    borderColor: '#7C3AED',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  notFoundIcon: {
    fontSize: 26,
  },
  notFoundTitle: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '800',
    marginBottom: 8,
  },
  notFoundBarcodeBadge: {
    backgroundColor: '#1F1138',
    borderColor: '#5B21B6',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
    marginBottom: 12,
  },
  notFoundBarcodeText: {
    color: '#E9D5FF',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
  },
  notFoundDesc: {
    color: '#9E97BA',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 20,
  },
  secondaryScanButton: {
    marginTop: 10,
    backgroundColor: '#18112C',
    borderColor: '#3B2067',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    width: '100%',
    alignItems: 'center',
  },
  secondaryScanButtonText: {
    color: '#C4B5FD',
    fontSize: 13.5,
    fontWeight: '700',
  },

  // Product Card
  productCard: {
    backgroundColor: '#140E26',
    borderColor: '#381E6D',
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 18,
    marginBottom: 20,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 6,
  },
  scoreRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  scoreBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    alignItems: 'center',
  },
  scoreBadgeLabel: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  scoreBadgeValue: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
  },
  novaBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  novaBadgeLabel: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  novaBadgeDesc: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  productImageWrapper: {
    backgroundColor: '#090514',
    borderColor: '#261548',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    height: 180,
  },
  productImage: {
    width: '100%',
    height: '100%',
  },
  productName: {
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '800',
    lineHeight: 27,
    marginBottom: 8,
  },
  productMetaTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  metaTag: {
    flexDirection: 'row',
    backgroundColor: '#1D1336',
    borderColor: '#432378',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  metaTagLabel: {
    color: '#8E87AA',
    fontSize: 12,
  },
  metaTagValue: {
    color: '#E9D5FF',
    fontSize: 12,
    fontWeight: '700',
  },
  allergenAlertBanner: {
    flexDirection: 'row',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: '#EF4444',
    borderWidth: 1.5,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  allergenAlertIcon: {
    fontSize: 22,
  },
  allergenAlertTitle: {
    color: '#FCA5A5',
    fontSize: 13,
    fontWeight: '800',
  },
  allergenAlertDesc: {
    color: '#FEE2E2',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  nutritionSection: {
    marginBottom: 16,
  },
  nutritionSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  nutritionSectionTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  nutritionSectionBasis: {
    color: '#8E87AA',
    fontSize: 11.5,
  },
  nutritionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  nutritionCard: {
    width: '48%',
    backgroundColor: '#181030',
    borderColor: '#2F1E5C',
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
  },
  nutritionCardIcon: {
    fontSize: 16,
    marginBottom: 2,
  },
  nutritionCardLabel: {
    color: '#8E87AA',
    fontSize: 11,
    marginBottom: 2,
  },
  nutritionCardValue: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  detailsBox: {
    backgroundColor: '#160F2C',
    borderColor: '#2E1A57',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  detailsBoxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  detailsBoxIcon: {
    fontSize: 14,
  },
  detailsBoxTitle: {
    color: '#A855F7',
    fontSize: 13,
    fontWeight: '800',
  },
  detailsBoxText: {
    color: '#C4B5FD',
    fontSize: 12.5,
    lineHeight: 18,
  },

  // Recent item enhancements
  recentItemName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '800',
    marginRight: 8,
  },
  recentScoreBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  recentScoreText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  recentItemBrand: {
    color: '#A39BBF',
    fontSize: 12,
    marginBottom: 4,
  },
  recentItemCalories: {
    color: '#D8B4FE',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 10,
  },
  recentActionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  recentItemViewDetails: {
    flex: 1,
    backgroundColor: '#27124E',
    borderColor: '#7C3AED',
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  recentItemViewDetailsText: {
    color: '#E9D5FF',
    fontSize: 11.5,
    fontWeight: '700',
  },

  // Source Attribution Tag
  sourceTagRow: {
    marginBottom: 12,
  },
  sourceBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  sourceBadgeText: {
    color: '#E9D5FF',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.6,
  },

  // Multi-Photo Capture Modules
  captureModuleCard: {
    backgroundColor: '#160F2B',
    borderColor: '#341A5C',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginTop: 10,
    width: '100%',
  },
  captureModuleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  captureModuleIcon: {
    fontSize: 22,
  },
  captureModuleTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  captureModuleSub: {
    color: '#9E97BA',
    fontSize: 11.5,
    marginTop: 1,
  },
  photoReadyBadge: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  photoReadyBadgeText: {
    color: '#6EE7B7',
    fontSize: 10.5,
    fontWeight: '800',
  },

  // Thumbnail Rows
  thumbnailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#0F091F',
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#261444',
  },
  miniThumbnail: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: '#080410',
  },
  thumbnailActionCol: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  thumbnailBtn: {
    flex: 1,
    backgroundColor: '#1E1238',
    borderColor: '#5B21B6',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailBtnText: {
    color: '#DDD6FE',
    fontSize: 12,
    fontWeight: '700',
  },

  // Dual Action Buttons (Take vs Upload)
  dualActionButtonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  moduleActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#20133A',
    borderColor: '#7C3AED',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  moduleActionBtnIcon: {
    fontSize: 14,
  },
  moduleActionBtnText: {
    color: '#EDE9FE',
    fontSize: 11.5,
    fontWeight: '700',
  },

  // Incomplete Database Record Card
  incompleteRecordCard: {
    backgroundColor: '#1C1335',
    borderColor: '#F59E0B',
    borderWidth: 1.5,
    borderRadius: 18,
    padding: 14,
    marginBottom: 16,
  },
  incompleteHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  incompleteIcon: {
    fontSize: 22,
  },
  incompleteTitle: {
    color: '#FBBF24',
    fontSize: 14.5,
    fontWeight: '800',
  },
  incompleteSub: {
    color: '#FDE68A',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  gapSubCard: {
    backgroundColor: '#130C24',
    borderColor: '#321D54',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  gapSubTitle: {
    color: '#E9D5FF',
    fontSize: 12.5,
    fontWeight: '700',
    marginBottom: 4,
  },
  gapAllergenWarning: {
    color: '#F87171',
    fontSize: 11.5,
    lineHeight: 15,
    marginBottom: 8,
    fontWeight: '600',
  },
  gapDesc: {
    color: '#A39BBF',
    fontSize: 11.5,
    lineHeight: 15,
    marginBottom: 8,
  },

  // Conflict Callout Card
  conflictCard: {
    backgroundColor: '#1C1530',
    borderColor: '#8B5CF6',
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  conflictTitle: {
    color: '#C4B5FD',
    fontSize: 13.5,
    fontWeight: '800',
    marginBottom: 4,
  },
  conflictDesc: {
    color: '#A39BBF',
    fontSize: 11.5,
    lineHeight: 15,
    marginBottom: 8,
  },
  conflictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
  },
  conflictField: {
    color: '#EDE9FE',
    fontSize: 12,
    fontWeight: '700',
  },
  conflictValue: {
    color: '#34D399',
    fontSize: 12,
    fontWeight: '700',
  },
  conflictOld: {
    color: '#9E97BA',
    fontSize: 11,
    fontWeight: '400',
  },

  // Allergen Missing Warning Banner & Medical Disclaimer
  allergenAlertBannerMissing: {
    flexDirection: 'row',
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#EF4444',
    borderWidth: 1.5,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  allergenMedicalDisclaimer: {
    color: '#FCA5A5',
    fontSize: 10.5,
    lineHeight: 14,
    marginTop: 6,
    fontStyle: 'italic',
  },

  // AI Error Banner
  aiErrorBanner: {
    flexDirection: 'row',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: '#DC2626',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
    marginTop: 14,
  },
  aiErrorIcon: {
    fontSize: 20,
  },
  aiErrorTitle: {
    color: '#F87171',
    fontSize: 13,
    fontWeight: '800',
  },
  aiErrorDesc: {
    color: '#FEE2E2',
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 2,
  },
  aiErrorHint: {
    color: '#FCA5A5',
    fontSize: 11,
    marginTop: 4,
    fontStyle: 'italic',
  },
  retryAiBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  retryAiBtnText: {
    color: '#FFFFFF',
    fontSize: 11.5,
    fontWeight: '700',
  },

  // Personalised Assessment Styles
  assessmentContainer: {
    borderRadius: 18,
    borderWidth: 1.5,
    padding: 16,
    marginBottom: 16,
  },
  assessmentContainerAvoid: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: '#EF4444',
  },
  assessmentContainerCaution: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: '#F59E0B',
  },
  assessmentContainerUnable: {
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    borderColor: '#8B5CF6',
  },
  assessmentContainerNoConflict: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: '#10B981',
  },
  assessmentHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  assessmentMainIcon: {
    fontSize: 28,
    marginTop: 2,
  },
  assessmentTopBadgeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  assessmentStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusPillAvoid: {
    backgroundColor: '#450A0A',
    borderColor: '#EF4444',
  },
  statusPillCaution: {
    backgroundColor: '#451A03',
    borderColor: '#F59E0B',
  },
  statusPillUnable: {
    backgroundColor: '#2E1065',
    borderColor: '#8B5CF6',
  },
  statusPillNoConflict: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  assessmentStatusPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statusPillTextAvoid: {
    color: '#FCA5A5',
  },
  statusPillTextCaution: {
    color: '#FCD34D',
  },
  statusPillTextUnable: {
    color: '#DDD6FE',
  },
  statusPillTextNoConflict: {
    color: '#6EE7B7',
  },
  assessmentEditProfileBtn: {
    backgroundColor: '#1F1538',
    borderColor: '#5B21B6',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  assessmentEditProfileText: {
    color: '#C4B5FD',
    fontSize: 11,
    fontWeight: '700',
  },
  assessmentOverallTitle: {
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '800',
    marginBottom: 2,
  },
  assessmentOverallSummary: {
    color: '#D8D4E8',
    fontSize: 12,
    lineHeight: 17,
  },
  assessmentItemsList: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  assessmentItemsHeader: {
    color: '#E9D5FF',
    fontSize: 12.5,
    fontWeight: '800',
    marginBottom: 8,
  },
  assessmentItemCard: {
    backgroundColor: '#130C22',
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
  },
  itemCardAvoid: {
    borderColor: 'rgba(239, 68, 68, 0.5)',
  },
  itemCardCaution: {
    borderColor: 'rgba(245, 158, 11, 0.5)',
  },
  itemCardUnable: {
    borderColor: 'rgba(168, 85, 247, 0.4)',
  },
  itemCardNoConflict: {
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  assessmentItemTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  assessmentItemRuleName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  itemMiniPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  itemMiniPillText: {
    fontSize: 9.5,
    fontWeight: '800',
  },
  assessmentItemHeadline: {
    color: '#F3E8FF',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  assessmentItemEvidence: {
    color: '#D4CDE6',
    fontSize: 11.5,
    lineHeight: 16,
  },
  assessmentItemFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  assessmentItemSource: {
    color: '#9E97BA',
    fontSize: 10.5,
    fontStyle: 'italic',
  },
  assessmentItemGuidance: {
    color: '#FDE68A',
    fontSize: 10.5,
    lineHeight: 14,
    marginTop: 4,
    fontStyle: 'italic',
  },
  noFiltersBox: {
    padding: 12,
    alignItems: 'center',
    backgroundColor: '#140C24',
    borderRadius: 10,
    marginTop: 10,
  },
  noFiltersText: {
    color: '#A39BBF',
    fontSize: 12,
    marginBottom: 6,
    textAlign: 'center',
  },
  setProfileBtn: {
    backgroundColor: '#2E1065',
    borderColor: '#7C3AED',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  setProfileBtnText: {
    color: '#DDD6FE',
    fontSize: 11.5,
    fontWeight: '700',
  },
  assessmentDisclaimerContainer: {
    backgroundColor: '#0D0818',
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#2E194D',
  },
  assessmentDisclaimerTitle: {
    color: '#F87171',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 4,
  },
  assessmentDisclaimerText: {
    color: '#B8B2CC',
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 2,
  },

  // Result Overview & Details Screen Styles
  profileButtonSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#161127',
    borderColor: '#2D1F50',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarSmallText: {
    fontSize: 16,
  },
  overviewHeroCard: {
    backgroundColor: '#120D22',
    borderColor: '#2A1B4E',
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
  },
  overviewHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  overviewProductThumb: {
    width: 64,
    height: 64,
    borderRadius: 14,
    backgroundColor: '#1B1430',
  },
  overviewProductPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 14,
    backgroundColor: '#1B1430',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overviewProductPlaceholderText: {
    fontSize: 28,
  },
  overviewHeroTextCol: {
    flex: 1,
  },
  provenancePill: {
    alignSelf: 'flex-start',
    backgroundColor: '#1D1336',
    borderColor: '#5B21B6',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginBottom: 4,
  },
  provenancePillText: {
    color: '#C4B5FD',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  overviewProductName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  overviewProductBrand: {
    color: '#9E97BA',
    fontSize: 12.5,
    marginTop: 2,
  },
  scoreHeroCard: {
    borderRadius: 24,
    borderWidth: 1.5,
    padding: 18,
    marginBottom: 14,
  },
  scoreHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  scoreCircleWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    borderWidth: 4,
    backgroundColor: '#0F091F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreNumber: {
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 30,
  },
  scoreNumberMuted: {
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 28,
  },
  scoreScale: {
    color: '#716A8C',
    fontSize: 10,
    fontWeight: '700',
  },
  verdictInfoCol: {
    flex: 1,
  },
  verdictBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  verdictBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  verdictBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  infoIconButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#23183D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoIconText: {
    fontSize: 14,
  },
  verdictHeadline: {
    color: '#F3E8FF',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  overviewConflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(139, 92, 246, 0.15)',
    borderColor: '#8B5CF6',
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
    marginTop: 12,
  },
  overviewConflictIcon: {
    fontSize: 15,
  },
  overviewConflictText: {
    flex: 1,
    color: '#DDD6FE',
    fontSize: 11.5,
    lineHeight: 15,
  },
  overviewMissingGapBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 12,
  },
  overviewMissingGapIcon: {
    fontSize: 20,
  },
  overviewMissingGapTitle: {
    color: '#FCD34D',
    fontSize: 12,
    fontWeight: '800',
  },
  overviewMissingGapSub: {
    color: '#FDE68A',
    fontSize: 11,
    marginTop: 2,
  },
  overviewMissingGapArrow: {
    color: '#FCD34D',
    fontSize: 16,
    fontWeight: '800',
  },
  quickStripContainer: {
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 20,
    padding: 14,
    marginBottom: 14,
  },
  quickStripHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  quickStripTitle: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '800',
  },
  quickStripBasis: {
    color: '#847D9E',
    fontSize: 11.5,
  },
  quickStripRow: {
    flexDirection: 'row',
    gap: 8,
  },
  quickMetricCard: {
    flex: 1,
    backgroundColor: '#1A1230',
    borderColor: '#362164',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  quickMetricIcon: {
    fontSize: 16,
    marginBottom: 3,
  },
  quickMetricValue: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '800',
    textAlign: 'center',
  },
  quickMetricLabel: {
    color: '#8E87AA',
    fontSize: 10.5,
    marginTop: 2,
    fontWeight: '600',
  },
  getMoreDetailsBtn: {
    backgroundColor: '#7C3AED',
    borderColor: '#C084FC',
    borderWidth: 1.5,
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    shadowColor: '#A855F7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  getMoreDetailsContent: {
    flex: 1,
  },
  getMoreDetailsTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  getMoreDetailsSub: {
    color: '#E9D5FF',
    fontSize: 11,
    marginTop: 2,
  },
  getMoreDetailsArrow: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    marginLeft: 8,
  },
  detailsProductHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#120D22',
    borderColor: '#2A1B4E',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 14,
  },
  detailsProductName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  detailsProductSub: {
    color: '#8A83A6',
    fontSize: 11.5,
    marginTop: 2,
  },
  verdictBadgeSmall: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  verdictBadgeSmallText: {
    color: '#FFFFFF',
    fontSize: 10.5,
    fontWeight: '800',
  },
  accordionCard: {
    backgroundColor: '#120D22',
    borderColor: '#241744',
    borderWidth: 1,
    borderRadius: 18,
    marginBottom: 12,
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: '#150F28',
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  accordionIcon: {
    fontSize: 18,
  },
  accordionTitle: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '800',
  },
  accordionToggle: {
    color: '#A855F7',
    fontSize: 14,
    fontWeight: '800',
  },
  accordionBody: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#241744',
  },
  accordionSummaryText: {
    color: '#EDE9FE',
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: '700',
  },
  accordionSubSummary: {
    color: '#A39BBF',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  testedRulesTitle: {
    color: '#D8B4FE',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
  },
  itemConflictCallout: {
    color: '#F472B6',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  detailBlock: {
    marginBottom: 12,
  },
  detailBlockLabel: {
    color: '#C4B5FD',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 3,
  },
  detailBlockValue: {
    color: '#EDE9FE',
    fontSize: 12.5,
    lineHeight: 18,
  },
  strictWarningCallout: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 6,
  },
  strictWarningTitle: {
    color: '#F87171',
    fontSize: 11.5,
    fontWeight: '800',
    marginBottom: 2,
  },
  strictWarningText: {
    color: '#FEE2E2',
    fontSize: 11,
    lineHeight: 15,
  },
  basisPillsContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  basisPill: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 10,
    backgroundColor: '#1A1230',
    borderColor: '#371F60',
    borderWidth: 1,
    alignItems: 'center',
  },
  basisPillActive: {
    backgroundColor: '#7C3AED',
    borderColor: '#C084FC',
  },
  basisPillText: {
    color: '#8E87AA',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  basisPillTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  basisSubtitle: {
    color: '#C4B5FD',
    fontSize: 11.5,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  nutritionClinicalDisclaimer: {
    color: '#8A859E',
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 10,
    fontStyle: 'italic',
  },
  ingredientsVerbatimTitle: {
    color: '#C4B5FD',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 12,
    marginBottom: 4,
  },
  ingredientsVerbatimText: {
    color: '#DDD6FE',
    fontSize: 12,
    lineHeight: 18,
  },
  noConflictsText: {
    color: '#10B981',
    fontSize: 12,
    fontWeight: '700',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 999,
  },
  modalCard: {
    backgroundColor: '#170F2C',
    borderColor: '#5B21B6',
    borderWidth: 1.5,
    borderRadius: 22,
    padding: 20,
    width: '100%',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 16.5,
    fontWeight: '800',
  },
  modalCloseBtn: {
    padding: 4,
  },
  modalCloseBtnText: {
    color: '#9E97BA',
    fontSize: 18,
    fontWeight: '800',
  },
  modalText: {
    color: '#DDD6FE',
    fontSize: 12.5,
    lineHeight: 19,
    marginBottom: 16,
  },
  modalActionBtn: {
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modalActionBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
