"""Physics questions with computed gold answers.

Physics is deliberately one of the largest categories. Each subject gets the
spread the spec asks for: conceptual, numerical, reverse, multi-step, unit
conversion, boundary, misconception, misleading wording, and
insufficient-information variants — because those probe genuinely different
failure modes. A model can be fine at plugging into F=ma and still assert a
number when the question is unanswerable.

Constants are stated IN the prompt wherever a result depends on them, so the
gold answer cannot drift with the model's choice of g.
"""

from __future__ import annotations

import math

from ..schema import Question

G = 9.8  # stated explicitly in every prompt that depends on it


def _q(**kw) -> Question:
    return Question(**kw)


def _num(qid, group, sub, skill, diff, qtype, prompt, ans, unit, why, adv=0, complexity="medium"):
    return _q(
        question_id=qid, group_id=group, category="physics", subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability="math", expected_complexity=complexity,
        evaluation_method="NUMERIC", gold_answer=float(ans),
        tolerance=abs(float(ans)) * 1e-3 + 1e-6, unit=unit,
        adversarial_level=adv, notes=why, source="computed",
    )


def kinematics() -> list[Question]:
    g = "phys-kin"
    out = [
        _num(f"{g}-00", g, "kinematics", "speed", "easy", "computation",
             "A car travels 150 km in 2 hours. What is its average speed in km/h? Give only the number.",
             75.0, "km/h", "distance/time"),
        _num(f"{g}-01", g, "kinematics", "distance", "easy", "reverse",
             "A car travels at 60 km/h for 45 minutes. How far does it go, in km? Give only the number.",
             45.0, "km", "reverse: requires converting 45 min to 0.75 h"),
        _num(f"{g}-02", g, "kinematics", "acceleration", "medium", "computation",
             "A car accelerates uniformly from 10 m/s to 30 m/s in 5 s. "
             "What is its acceleration in m/s^2? Give only the number.",
             4.0, "m/s^2", "(v-u)/t"),
        _num(f"{g}-03", g, "kinematics", "suvat", "medium", "multi_step",
             "A car starting from rest accelerates at 3 m/s^2 for 6 s. "
             "How far has it travelled, in metres? Give only the number.",
             0.5 * 3 * 36, "m", "s = ut + 0.5at^2 with u=0"),
        _num(f"{g}-04", g, "kinematics", "free_fall", "medium", "computation",
             "An object is dropped from rest. Using g = 9.8 m/s^2 and ignoring air resistance, "
             "what is its speed after 3 s, in m/s? Give only the number.",
             G * 3, "m/s", "v = gt"),
        _num(f"{g}-05", g, "kinematics", "free_fall", "hard", "reverse",
             "Using g = 9.8 m/s^2 and ignoring air resistance, from what height must an object be "
             "dropped from rest to reach the ground in exactly 2 s? Give only the number of metres.",
             0.5 * G * 4, "m", "reverse: h = 0.5gt^2"),
        _num(f"{g}-06", g, "kinematics", "free_fall", "hard", "misconception",
             "Two balls, one 1 kg and one 10 kg, are dropped simultaneously from the same height in a "
             "vacuum. Using g = 9.8 m/s^2, how many seconds after the 1 kg ball does the 10 kg ball land? "
             "Give only the number.",
             0.0, "s", "mass-independence of free fall; the tempting answer is 'the heavy one lands first'",
             adv=1),
        # Deliberately unanswerable.
        _q(question_id=f"{g}-07", group_id=g, category="physics", subcategory="kinematics",
           skill="insufficient_information", difficulty="adversarial", question_type="insufficient_info",
           prompt=("A car accelerates from rest. How fast is it going after 10 seconds? "
                   "Give the speed in m/s."),
           expected_capability="math", expected_complexity="simple",
           evaluation_method="REFUSAL", adversarial_level=3,
           rubric=[
               "Identifies that the acceleration is not given.",
               "Does not invent an acceleration value (e.g. assuming 9.8 m/s^2 or 'a typical car').",
               "Either asks for the acceleration or states the problem is underdetermined.",
           ],
           notes="a confident number here is fabrication, not calculation",
           source="underdetermined: acceleration is never stated"),
        _q(question_id=f"{g}-08", group_id=g, category="physics", subcategory="kinematics",
           skill="vector_vs_scalar", difficulty="hard", question_type="misconception",
           prompt=("An athlete runs exactly once around a 400 m circular track and stops at the "
                   "starting line. What is the total DISPLACEMENT, in metres? Give only the number."),
           expected_capability="math", expected_complexity="simple",
           evaluation_method="NUMERIC", gold_answer=0.0, tolerance=1e-9, unit="m",
           adversarial_level=2,
           notes="displacement (0) vs distance (400) — the wording invites 400",
           source="definition of displacement"),
    ]
    return out


def forces() -> list[Question]:
    g = "phys-force"
    out = [
        _num(f"{g}-00", g, "newton_second_law", "force", "easy", "computation",
             "A 5 kg mass accelerates at 3 m/s^2. What net force acts on it, in newtons? Give only the number.",
             15.0, "N", "F = ma"),
        _num(f"{g}-01", g, "newton_second_law", "mass", "medium", "reverse",
             "A net force of 24 N produces an acceleration of 4 m/s^2. What is the mass in kg? "
             "Give only the number.",
             6.0, "kg", "reverse: m = F/a"),
        _num(f"{g}-02", g, "weight", "weight_vs_mass", "medium", "unit_conversion",
             "Using g = 9.8 m/s^2, what is the weight of a 12 kg object on Earth, in newtons? "
             "Give only the number.",
             12 * G, "N", "weight is a force; mass is not"),
        _num(f"{g}-03", g, "weight", "weight_vs_mass", "hard", "misconception",
             "An astronaut has a mass of 70 kg on Earth. What is her MASS on the Moon, in kg? "
             "Give only the number.",
             70.0, "kg", "mass is invariant; only weight changes", adv=2),
        _num(f"{g}-04", g, "friction", "friction_force", "medium", "computation",
             "A 10 kg block sits on a horizontal surface with coefficient of kinetic friction 0.3. "
             "Using g = 9.8 m/s^2, what is the friction force while it slides, in newtons? "
             "Give only the number.",
             0.3 * 10 * G, "N", "f = mu*N, N = mg on a level surface"),
        _num(f"{g}-05", g, "newton_second_law", "net_force", "hard", "multi_step",
             "A 4 kg block is pushed with 30 N horizontally against a friction force of 10 N. "
             "What is its acceleration in m/s^2? Give only the number.",
             (30 - 10) / 4, "m/s^2", "net force first, then a = F_net/m"),
        _q(question_id=f"{g}-06", group_id=g, category="physics", subcategory="newton_third_law",
           skill="action_reaction", difficulty="hard", question_type="conceptual",
           prompt=("A truck collides head-on with a small car. During the collision, which experiences "
                   "the greater FORCE, and which experiences the greater ACCELERATION? Explain briefly."),
           expected_capability="reasoning", expected_complexity="medium",
           evaluation_method="RUBRIC", adversarial_level=2,
           rubric=[
               "States the forces on each are EQUAL in magnitude (Newton's third law).",
               "States the CAR experiences the greater acceleration.",
               "Attributes the acceleration difference to the car's smaller mass (a = F/m).",
               "Does not claim the truck exerts more force than the car.",
           ],
           notes="the intuitive answer 'the truck hits harder' is wrong for force, right for acceleration",
           source="Newton's third law; a = F/m"),
        _q(question_id=f"{g}-07", group_id=g, category="physics", subcategory="newton_first_law",
           skill="inertia", difficulty="medium", question_type="conceptual",
           prompt=("A spacecraft is drifting in deep space, far from any star or planet, with its engines "
                   "switched off. Describe its subsequent motion and justify it."),
           expected_capability="reasoning", expected_complexity="simple",
           evaluation_method="RUBRIC",
           rubric=[
               "States it continues at constant velocity (constant speed in a straight line).",
               "States it does NOT slow down or stop.",
               "Invokes Newton's first law / inertia / absence of net force.",
           ],
           notes="tests the everyday 'things stop on their own' intuition",
           source="Newton's first law"),
    ]
    return out


def energy_momentum() -> list[Question]:
    g = "phys-energy"
    out = [
        _num(f"{g}-00", g, "kinetic_energy", "ke", "medium", "computation",
             "What is the kinetic energy of a 2 kg object moving at 10 m/s, in joules? Give only the number.",
             0.5 * 2 * 100, "J", "KE = 0.5mv^2"),
        _num(f"{g}-01", g, "kinetic_energy", "ke_scaling", "hard", "misconception",
             "A car's speed doubles from 20 m/s to 40 m/s. By what FACTOR does its kinetic energy increase? "
             "Give only the number.",
             4.0, "dimensionless", "KE scales with v^2, so doubling v quadruples KE, not doubles it", adv=1),
        _num(f"{g}-02", g, "potential_energy", "pe", "medium", "computation",
             "Using g = 9.8 m/s^2, what is the gravitational potential energy of a 3 kg object "
             "raised 5 m above the ground, in joules? Give only the number.",
             3 * G * 5, "J", "PE = mgh"),
        _num(f"{g}-03", g, "energy_conservation", "conservation", "hard", "multi_step",
             "Using g = 9.8 m/s^2 and ignoring air resistance, an object is dropped from rest at a height "
             "of 20 m. What is its speed just before impact, in m/s? Give only the number.",
             math.sqrt(2 * G * 20), "m/s", "mgh = 0.5mv^2, mass cancels"),
        _num(f"{g}-04", g, "work", "work", "medium", "computation",
             "A constant 25 N force pushes an object 4 m in the direction of the force. "
             "How much work is done, in joules? Give only the number.",
             100.0, "J", "W = Fd"),
        _num(f"{g}-05", g, "work", "work_perpendicular", "hard", "misconception",
             "A person carries a 20 kg suitcase horizontally for 50 m at constant speed. "
             "How much work does the CARRYING force do against gravity, in joules? Give only the number.",
             0.0, "J", "force is vertical, displacement horizontal, so W = 0", adv=2),
        _num(f"{g}-06", g, "power", "power", "medium", "computation",
             "A machine does 600 J of work in 4 s. What is its power output in watts? Give only the number.",
             150.0, "W", "P = W/t"),
        _num(f"{g}-07", g, "momentum", "momentum", "easy", "computation",
             "What is the momentum of a 6 kg object moving at 4 m/s, in kg m/s? Give only the number.",
             24.0, "kg m/s", "p = mv"),
        _num(f"{g}-08", g, "momentum", "collision", "extreme", "multi_step",
             "A 2 kg trolley moving at 3 m/s collides with a stationary 4 kg trolley and they stick "
             "together. What is their common velocity afterwards, in m/s? Give only the number.",
             (2 * 3) / 6, "m/s", "perfectly inelastic: momentum conserved, KE is not"),
        _num(f"{g}-09", g, "impulse", "impulse", "hard", "computation",
             "A 0.5 kg ball moving at 8 m/s is brought to rest in 0.2 s. "
             "What is the magnitude of the average force, in newtons? Give only the number.",
             (0.5 * 8) / 0.2, "N", "impulse = change in momentum = Ft"),
    ]
    return out


def electricity_waves() -> list[Question]:
    g = "phys-elec"
    out = [
        _num(f"{g}-00", g, "ohms_law", "voltage", "easy", "computation",
             "A resistor of 20 ohms carries a current of 3 A. What is the voltage across it, in volts? "
             "Give only the number.",
             60.0, "V", "V = IR"),
        _num(f"{g}-01", g, "ohms_law", "resistance", "medium", "reverse",
             "A 12 V supply drives 0.5 A through a resistor. What is its resistance in ohms? "
             "Give only the number.",
             24.0, "ohm", "reverse: R = V/I"),
        _num(f"{g}-02", g, "circuits", "series", "medium", "computation",
             "Three resistors of 10, 20 and 30 ohms are connected in SERIES. "
             "What is the total resistance in ohms? Give only the number.",
             60.0, "ohm", "series resistances add"),
        _num(f"{g}-03", g, "circuits", "parallel", "hard", "computation",
             "Two resistors of 10 and 15 ohms are connected in PARALLEL. "
             "What is the total resistance in ohms? Give only the number.",
             1 / (1 / 10 + 1 / 15), "ohm", "parallel is always less than the smallest branch"),
        _num(f"{g}-04", g, "electrical_power", "power", "medium", "computation",
             "A device draws 2 A at 120 V. What power does it consume, in watts? Give only the number.",
             240.0, "W", "P = VI"),
        _num(f"{g}-05", g, "waves", "wave_equation", "medium", "computation",
             "A wave has frequency 50 Hz and wavelength 4 m. What is its speed in m/s? Give only the number.",
             200.0, "m/s", "v = f * lambda"),
        _num(f"{g}-06", g, "waves", "wave_equation", "medium", "reverse",
             "A sound wave travels at 340 m/s with a frequency of 170 Hz. "
             "What is its wavelength in metres? Give only the number.",
             2.0, "m", "reverse: lambda = v/f"),
        _num(f"{g}-07", g, "waves", "period_frequency", "easy", "computation",
             "A wave has a period of 0.02 s. What is its frequency in hertz? Give only the number.",
             50.0, "Hz", "f = 1/T"),
        _q(question_id=f"{g}-08", group_id=g, category="physics", subcategory="waves",
           skill="medium_dependence", difficulty="hard", question_type="misconception",
           prompt=("A sound wave passes from air into water. Does its FREQUENCY change, does its "
                   "WAVELENGTH change, or both? Explain briefly."),
           expected_capability="reasoning", expected_complexity="medium",
           evaluation_method="RUBRIC", adversarial_level=1,
           rubric=[
               "States the frequency does NOT change.",
               "States the wavelength DOES change.",
               "Attributes this to the wave speed differing between media while the source frequency is fixed.",
           ],
           notes="frequency is set by the source, not the medium",
           source="wave relation v = f*lambda with f fixed by the source"),
    ]
    return out


def fluids_thermal() -> list[Question]:
    g = "phys-fluid"
    out = [
        _num(f"{g}-00", g, "density", "density", "easy", "computation",
             "An object has mass 250 g and volume 50 cm^3. What is its density in g/cm^3? "
             "Give only the number.",
             5.0, "g/cm^3", "rho = m/V"),
        _num(f"{g}-01", g, "density", "volume", "medium", "reverse",
             "A material has density 2.5 g/cm^3. What volume, in cm^3, does 200 g of it occupy? "
             "Give only the number.",
             80.0, "cm^3", "reverse: V = m/rho"),
        _num(f"{g}-02", g, "pressure", "pressure", "medium", "computation",
             "A force of 500 N is applied over an area of 0.25 m^2. "
             "What is the pressure in pascals? Give only the number.",
             2000.0, "Pa", "P = F/A"),
        _num(f"{g}-03", g, "pressure", "pressure_area", "hard", "conceptual",
             "The same 600 N force is applied first over 2 m^2 and then over 0.5 m^2. "
             "By what FACTOR does the pressure increase? Give only the number.",
             4.0, "dimensionless", "pressure is inversely proportional to area"),
        _num(f"{g}-04", g, "unit_conversion", "temperature", "medium", "unit_conversion",
             "Convert 25 degrees Celsius to kelvin. Give only the number.",
             298.15, "K", "K = C + 273.15"),
        _num(f"{g}-05", g, "unit_conversion", "temperature", "hard", "unit_conversion",
             "Convert -40 degrees Celsius to Fahrenheit. Give only the number.",
             -40.0, "F", "the one temperature where the two scales coincide"),
        _num(f"{g}-06", g, "unit_conversion", "speed", "medium", "unit_conversion",
             "Convert 72 km/h to m/s. Give only the number.",
             20.0, "m/s", "divide by 3.6"),
        _num(f"{g}-07", g, "thermal", "specific_heat", "hard", "computation",
             "How much energy, in joules, is needed to raise the temperature of 2 kg of water by 10 K? "
             "Use specific heat capacity 4200 J/(kg K). Give only the number.",
             2 * 4200 * 10, "J", "Q = mc(delta)T"),
        _q(question_id=f"{g}-08", group_id=g, category="physics", subcategory="thermal",
           skill="phase_change", difficulty="hard", question_type="misconception",
           prompt=("Ice at 0 degrees Celsius is heated until it becomes water at 0 degrees Celsius. "
                   "What happens to its temperature during the melting, and why does it take energy?"),
           expected_capability="reasoning", expected_complexity="medium",
           evaluation_method="RUBRIC",
           rubric=[
               "States the temperature stays constant during the phase change.",
               "Identifies the energy as latent heat (of fusion).",
               "Explains it goes into breaking intermolecular bonds rather than raising temperature.",
           ],
           notes="tests 'adding heat always raises temperature'",
           source="latent heat of fusion; temperature is constant during a phase change"),
    ]
    return out


def dimensional_analysis() -> list[Question]:
    g = "phys-dim"
    out = [
        _q(question_id=f"{g}-00", group_id=g, category="physics", subcategory="dimensional_analysis",
           skill="unit_check", difficulty="hard", question_type="conceptual",
           prompt=("A student writes the formula v = a*t^2 for the speed of an object under constant "
                   "acceleration. Use dimensional analysis to decide whether this can be correct, "
                   "and give the correct relation if it is not."),
           expected_capability="reasoning", expected_complexity="medium",
           evaluation_method="RUBRIC", adversarial_level=1,
           rubric=[
               "States the formula is dimensionally INCORRECT.",
               "Shows a*t^2 has dimensions of length, not speed.",
               "Gives the correct relation v = a*t (for an object starting from rest).",
           ],
           notes="checks whether unit reasoning is actually applied",
           source="dimensional analysis: [a][t^2] = length, not length/time"),
        _q(question_id=f"{g}-01", group_id=g, category="physics", subcategory="dimensional_analysis",
           skill="unit_check", difficulty="extreme", question_type="false_premise",
           prompt=("Given that force has SI units of newtons and distance metres, what are the SI units of "
                   "the quantity force divided by distance-squared? Name the resulting unit combination."),
           expected_capability="reasoning", expected_complexity="medium",
           evaluation_method="RUBRIC",
           rubric=[
               "Derives N/m^2 ... specifically kg m^-1 s^-2 divided by an extra metre, i.e. N/m^2.",
               "Recognises N/m^2 is the pascal (pressure) ONLY if it correctly notes F/A not F/d^2 — "
               "or explicitly states F/d^2 is not a standard named quantity.",
               "Does not invent a nonexistent named unit.",
           ],
           notes="tempts a false identification with pressure; F/d^2 is dimensionally pressure "
                 "but is not the definition of pressure",
           source="SI dimensional analysis; pressure is defined as F/A",
           adversarial_level=2),
    ]
    return out


def all_questions() -> list[Question]:
    return (kinematics() + forces() + energy_momentum()
            + electricity_waves() + fluids_thermal() + dimensional_analysis())
